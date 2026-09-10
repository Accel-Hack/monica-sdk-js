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

`MONICA_DSN` は `https://<secret-key>@<ingest-host>` の形式。パスを付けても構わないが、
送信先は origin に `/v1/envelope` を付けたものになり、DSN のパス・クエリ・フラグメントは
捨てられる。project の識別はキーで行われるので、DSN のパスに project id を書く必要はない。
MONICAへイベントを送るにはプロジェクトのAPIキーが必要。Node.jsサーバでは
管理画面で発行したsecret key（`msk_...`）を環境変数にだけ保存し、ソースコード、
ログ、クライアント配信物には含めない。npmからpackageをinstallするだけなら、
MONICAのAPIキーは不要。
終了時は送信を無期限に待たないよう、タイムアウトを指定する。

```ts
await monica.flush(2_000);
await monica.close(2_000);
```

## 送信が拒否されたとき

`422`（envelope schema 不正）のとき、既定で`console.warn`へ1行出す。

```
monica: ingest rejected the envelope with 422 (invalid_envelope): 1 issue(s); $.items[0].request.method: Invalid type: Expected string
```

自前のloggerへ流す場合は`onDiagnostic`を渡す。`null`を渡すと何も出さない。

```ts
export const monica = createNodeClient({
  dsn: process.env.MONICA_DSN!,
  environment: process.env.NODE_ENV ?? "development",
  onDiagnostic(diagnostic) {
    logger.warn(diagnostic.message, { issues: diagnostic.issues });
  },
});
```

`flush()`の戻り値の`status` / `issues` / `error`からも取得できる。

### 鍵が失効したとき（401）

鍵を失効・ローテートしたあとも動き続けているプロセスが、受理されない endpoint へ
`flushIntervalMs`ごとに永久にPOSTし続けないよう、`401`を受けたSDKは送信を止める。

```
monica: ingest rejected the envelope with 401 (invalid_key); no further envelopes will be sent
```

止まったあとの`captureException` / `captureMessage`は`null`を返し、queueに残っていた
分（停止と同時に進行していた`beforeSend`の分も含む）は`flush()`の戻り値の
`discarded`に勘定される。`stopped: true`で判定できる。
送信を再開するには正しい鍵で`createNodeClient`を呼び直す。

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
