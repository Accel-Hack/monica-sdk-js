# @ah-monica/next

Next.js App Router の client / server の両方から MONICA へエラーを送る SDK。
root export は持たず、`@ah-monica/next/client` と `@ah-monica/next/server` に分かれている。

- Next.js 15.3 以上 17 未満（peer dependency）
- Node.js 20.9 以上
- App Router（`instrumentation-client.ts`、`instrumentation.ts`、Error Boundary）
- Edge runtime は対象外

共通の使い方・オプション・制約は [ルートの README](../README.md) にある。

## インストール

```bash
npm install @ah-monica/next
```

## 使い方

### Client

client bundle に含めてよい public key（`mpk_...`）だけを使う。`msk_...` を渡すと
`TypeError` を投げる。管理画面で public key の許可 origin も設定する。

```ts
// src/infrastructure/monica.client.ts
import { createNextClient } from "@ah-monica/next/client";

export const monica = createNextClient({
  dsn: process.env.NEXT_PUBLIC_MONICA_DSN!,
  environment: process.env.NEXT_PUBLIC_MONICA_ENVIRONMENT ?? "development",
  release: process.env.NEXT_PUBLIC_MONICA_RELEASE,
  beforeSend(item) {
    // どの値が個人情報かはアプリケーション固有。送ってよい値だけを残す。
    return item;
  },
});
```

`installGlobalHandlers()` は `error` と `unhandledrejection` を購読する。
何度呼んでも listener は 1 組だけで、戻り値を呼ぶと解除できる。

```ts
// instrumentation-client.ts
import { monica } from "./src/infrastructure/monica.client";

monica.installGlobalHandlers();
```

Error Boundary から明示的に送る場合:

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

`setUser` / `addBreadcrumb` / `captureMessage` / `flush` / `close` も使える。

### Server（Node runtime）

secret key（`msk_...`）をサーバ専用の環境変数に置く。`NEXT_PUBLIC_` を付けてはならない。
`@ah-monica/next/server` は Node runtime 専用で、Edge runtime では使わない。

```ts
// src/infrastructure/monica.server.ts
import { createNextServerClient } from "@ah-monica/next/server";

export const monica = createNextServerClient({
  dsn: process.env.MONICA_DSN!,
  environment: process.env.MONICA_ENVIRONMENT ?? process.env.NODE_ENV!,
  release: process.env.MONICA_RELEASE,
  beforeSend(item) {
    // request や user を足す場合も、この境界で個人情報を処理する。
    return item;
  },
});
```

```ts
// instrumentation.ts
import { monica } from "./src/infrastructure/monica.server";

export const onRequestError = monica.onRequestError;
```

`onRequestError` は送信完了まで await する。Next.js から渡される URL と headers は
収集せず、`contexts.next` に route の種別だけを足す（`routerKind`、`routePath`、
`routeType`、`renderSource`、`revalidateReason`、`renderType` のうち渡されたもの）。
tag には `next.router_kind` と `next.route_type` が付く。

Server Action や Route Handler では `monica.captureException(error)` を直接呼べる。
server client は [`@ah-monica/node`](../node/README.md) のクライアントと同じ API
（`withScope`、`installProcessHooks` など）を持つ。

## オプション

client / server とも同じ option を取る（server は `@ah-monica/node` と同一）。

| option | 型 | default | 説明 |
| --- | --- | --- | --- |
| `dsn` | `string` | 必須 | client は `mpk_...`、server は `msk_...` |
| `environment` | `string` | 必須 | 1〜128 文字 |
| `release` | `string` | なし | item の `release` に載る |
| `sampleRate` | `number` | `1` | 0〜1 |
| `maxBreadcrumbs` | `number` | `50` | 保持する breadcrumb 数 |
| `maxQueueSize` | `number` | `100` | queue の上限 |
| `batchSize` | `number` | `30` | 1 envelope に載せる item 数 |
| `flushIntervalMs` | `number` | `5000` | queue に item がある間の自動送信間隔 |
| `requestTimeoutMs` | `number` | `2000` | 1 回の HTTP request の上限 |
| `maxRetries` | `number` | `5` | `429` / `5xx` / network 障害の再送回数 |
| `onDiagnostic` | `(diagnostic) => void \| null` | `console.warn` に 1 行 | 拒否されたときの診断の受け取り先。`null` で無効 |
| `beforeSend` | `(item, hint) => item \| null \| Promise<...>` | なし | `null` を返すと破棄 |
| `fetch` | `typeof fetch` | `globalThis.fetch` | 送信に使う fetch |

## 送信結果と診断

拒否されたときは client / server とも既定で `console.warn` に 1 行出る（`422` / `401` / `413`）。
ブラウザの console に出したくない場合は `onDiagnostic` で差し替える（`null` で無効）。
`flush()` の戻り値の `status` / `issues` / `error` / `stopped` からも取れる。
詳しくは [TROUBLESHOOTING.md](../TROUBLESHOOTING.md)。

## 制約

- `@ah-monica/next/client` に secret key（`msk_...`）を渡すと `TypeError` を投げる。
- client の `installGlobalHandlers()` は subresource（`<img>` / `<script>` / `<link>`）の
  読み込み失敗を送らない。送るのは未捕捉の例外と unhandled rejection だけ。
- root export は無い。`@ah-monica/next` をそのまま import することはできない。

## ライセンス

[Apache-2.0](LICENSE)
