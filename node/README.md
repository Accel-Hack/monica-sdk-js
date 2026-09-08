# @ah-monica/node

Node.js 20+ のサーバアプリケーションから MONICA へエラーを送るSDK。
ESM packageなので、Node.js 20+・TypeScript・任意のpackage managerを使うアプリケーションからそのまま利用できる。

```ts
import { createNodeClient } from "@ah-monica/node";

export const monica = createNodeClient({
  dsn: process.env.MONICA_DSN!,
  environment: process.env.NODE_ENV ?? "development",
  release: process.env.GIT_SHA,
  beforeSend(item) {
    // PIIの定義はアプリケーション固有。利用側で送信可能な値だけにする。
    delete item.user;
    if (item.request) delete item.request.headers;
    return item;
  },
});

try {
  await runTask();
} catch (error) {
  await monica.captureException(error, { tags: { component: "server-runtime" } });
  throw error;
}
```

`MONICA_DSN` は `https://<secret-key>@<ingest-host>/<project-id>` の形式。
MONICAへイベントを送るにはプロジェクトのAPIキーが必要。Node.jsサーバでは
管理画面で発行したsecret key（`msk_...`）を環境変数にだけ保存し、ソースコード、
ログ、クライアント配信物には含めない。npmからpackageをinstallするだけなら、
MONICAのAPIキーは不要。
終了時は送信を無期限に待たないよう、タイムアウトを指定する。

```ts
await monica.flush(2_000);
await monica.close(2_000);
```

## PII方針

SDKは、文字列やオブジェクトがPIIかどうかを推測せず、自動除去もしない。
送信する値の選択と除去は利用アプリケーションの責任であり、`beforeSend`を
そのための最終境界として提供する。MONICAサーバの既知credentialフィルターは
防御層であり、任意のPIIが除去される保証ではない。

## プロセスフック

importしただけではグローバルhookを登録しない。必要な場合だけ明示的に登録し、
テストやshutdown時に解除する。

```ts
const uninstall = monica.installProcessHooks();
// ...
uninstall();
```

既定では、終了動作を変えない `uncaughtExceptionMonitor` だけを使う。
`unhandledRejection: true` はNode.jsの既定終了動作を変えるため、アプリ側で
終了方針も管理する場合にだけ有効にする。
