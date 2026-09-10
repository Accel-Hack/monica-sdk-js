# @ah-monica/next

MONICAをNext.js App Routerのclient / serverの両方から利用するためのSDK。
実行環境を誤って混在させないよう、root exportは持たず`/client`と`/server`を明示的に分離する。

## Install

```bash
npm install @ah-monica/next
```

## Client

client bundleに含めてよいpublic key（`mpk_...`）だけを使用する。`msk_...`はSDKが拒否する。
管理画面でpublic keyの許可originも設定する。

```ts
// src/infrastructure/monica.client.ts
import { createNextClient } from "@ah-monica/next/client";

export const monica = createNextClient({
  dsn: process.env.NEXT_PUBLIC_MONICA_DSN!,
  environment: process.env.NEXT_PUBLIC_MONICA_ENVIRONMENT ?? "development",
  release: process.env.NEXT_PUBLIC_MONICA_RELEASE,
  beforeSend(item) {
    // PIIを判定・除去できるのはアプリケーションだけなので、ここで処理する。
    return item;
  },
});
```

```ts
// instrumentation-client.ts
import { monica } from "./src/infrastructure/monica.client";

monica.installGlobalHandlers();
```

Error Boundaryから明示的に送る場合:

```tsx
"use client";

import { useEffect } from "react";
import { monica } from "../infrastructure/monica.client";

export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    void monica.captureException(error, {
      contexts: { next: { digest: error.digest } },
    });
  }, [error]);

  return <p>エラーが発生しました。</p>;
}
```

## Server（Node runtime）

server側はsecret key（`msk_...`）をサーバ専用環境変数に保存する。
`MONICA_DSN`に`NEXT_PUBLIC_`を付けてはならない。`@ah-monica/next/server`はNode runtime専用で、
Edge runtimeでは使用しない。

```ts
// src/infrastructure/monica.server.ts
import { createNextServerClient } from "@ah-monica/next/server";

export const monica = createNextServerClient({
  dsn: process.env.MONICA_DSN!,
  environment: process.env.MONICA_ENVIRONMENT ?? process.env.NODE_ENV,
  release: process.env.MONICA_RELEASE,
  beforeSend(item) {
    // request、userなどを追加する場合も、この境界でPIIを処理する。
    return item;
  },
});
```

```ts
// instrumentation.ts
import { monica } from "./src/infrastructure/monica.server";

export const onRequestError = monica.onRequestError;
```

`onRequestError`は送信完了までawaitする。Next.jsから渡される実URL・headersは、PIIやsecretを
含む可能性があるため自動収集しない。route templateやrouter種別だけを`contexts.next`へ追加する。
Server ActionやRoute Handlerでは`monica.captureException(error)`も直接利用できる。

## 送信が拒否されたとき

`422`（envelope schema 不正）のとき、client / server とも既定で`console.warn`へ
1行出す。

```
monica: ingest rejected the envelope with 422 (invalid_envelope): 1 issue(s); $.items[0].request.method: Invalid type: Expected string
```

browserのconsoleに出したくない場合は`onDiagnostic`を渡して差し替える（`null`で無効化）。
`flush()`の戻り値の`status` / `issues` / `error`からも取得できる。

`401`（public keyの失効、許可originの不一致）を受けると、そのclientからは以後
1回もPOSTしない。`flush()`の戻り値の`stopped: true`と次の1行で分かる。

```
monica: ingest rejected the envelope with 401 (invalid_key); no further envelopes will be sent
```

## PII

SDKはPIIを推測して除去しない。アプリケーションが`beforeSend`で削除・マスク・破棄する。
client/serverとも、明示的に渡した`user`、`request`、`contexts`などはそのまま送信対象になる。

## Runtime support

- Next.js 15 / 16
- Node.js 20.9以上
- App Router（`instrumentation-client.ts`、`instrumentation.ts`、Error Boundary）
- Edge runtimeは対象外。必要な場合はruntime-neutralな別adapterを使用する。
