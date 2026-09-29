# @ah-monica/node

Node.js のサーバアプリケーションから MONICA へエラーを送る SDK。Node.js 20 以上の ESM package。

共通の使い方・オプション・制約は [ルートの README](../README.md) にある。

## インストール

```bash
npm install @ah-monica/node
```

## 初期化

DSN には secret key（`msk_...`）を使い、環境変数にだけ置く。

```ts
import { createNodeClient } from "@ah-monica/node";

export const monica = createNodeClient({
  dsn: process.env.MONICA_DSN,
  environment: process.env.NODE_ENV ?? "development",
  release: process.env.GIT_SHA,
  beforeSend(item) {
    // どの値が個人情報かはアプリケーション固有。送ってよい値だけを残す。
    delete item.user;
    if (item.request) delete item.request.headers;
    return item;
  },
});
```

## 使い方

```ts
try {
  await runTask();
} catch (error) {
  await monica.captureException(error, { tags: { component: "server-runtime" } });
  throw error;
}

monica.captureMessage("queue backlog is growing", "warning");
```

プロセスが終わる前に、タイムアウトを指定して送信を待つ。

```ts
await monica.flush(2_000);
await monica.close(2_000);
```

### scope

`setUser` / `addBreadcrumb` は現在の scope（`withScope` の外ではプロセス全体の scope）を
更新する。`withScope` は `AsyncLocalStorage` でその callback の中だけに閉じた scope を
作るので、request ごとの文脈はこちらに入れる。

```ts
app.use((req, res, next) => {
  monica.withScope((scope) => {
    scope.setUser({ id: req.userId });
    scope.setTag("route", req.route.path);
    scope.addBreadcrumb({ category: "http", message: "request received" });
    next();
  });
});
```

### プロセスフック

import しただけではグローバル hook を登録しない。必要な場合だけ明示的に登録し、
テストや shutdown で解除する。

```ts
const uninstall = monica.installProcessHooks();
// ...
uninstall();
```

| option | 型 | default | 説明 |
| --- | --- | --- | --- |
| `uncaughtException` | `boolean` | `true` | `uncaughtExceptionMonitor` で `level: "fatal"` として送る。Node.js の終了動作は変えない |
| `unhandledRejection` | `boolean` | `false` | `unhandledRejection` を購読する。listener を付けると Node.js の既定の終了動作が変わるので、終了方針もアプリケーション側で管理する場合にだけ有効にする |

## オプション

| option | 型 | default | 説明 |
| --- | --- | --- | --- |
| `dsn` | `string \| null` | なし | `https://msk_...@<ingest-host>`。未指定・空文字なら何も送らない |
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

拒否されたときは既定で `console.warn` に 1 行出る（`422` / `401` / `413`）。
`flush()` の戻り値の `status` / `issues` / `error` / `stopped` からも取れる。
詳しくは [TROUBLESHOOTING.md](../TROUBLESHOOTING.md)。

## 稼働確認

共通の仕組みは [ルートの README](../README.md#稼働確認) にある。

- `createNodeClient()` を呼んだときに `trigger: "start"` を判定し、以後は interval の期限が来るたびに
  `trigger: "interval"` を判定する。タイマーは `unref` した `setTimeout` 1 本で、プロセスの終了を妨げない
- `close()` を呼ぶとタイマーが止まり、以後は送らない
- 状態（interval を数え始めた時刻と header の値）はプロセスのメモリに持つ。再起動すると `start` を送り直し、
  cluster や複数 instance ではプロセスごとに送る
- プロセスが凍結される環境（AWS Lambda など）ではタイマーが発火しないことがあり、起動ごとの `start` だけになる

## ライセンス

[Apache-2.0](LICENSE)
