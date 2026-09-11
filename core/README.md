# @ah-monica/core

MONICA SDK のランタイム非依存な envelope 組み立て・バッファ・送信。
`fetch` と `CompressionStream` があるランタイムで動く。依存 package は無い。

Node.js・Cloudflare Workers・Next.js では、この package を直接使わず
[`@ah-monica/node`](../node/README.md) / [`@ah-monica/cloudflare`](../cloudflare/README.md) /
[`@ah-monica/next`](../next/README.md) を使う。この README は、対応 adapter の無い
ランタイムに自分で載せる場合の入口をまとめる。

共通の使い方・オプション・制約は [ルートの README](../README.md) にある。

## インストール

```bash
npm install @ah-monica/core
```

## 初期化

transport と client を別々に組み立てる。

```ts
import { createCoreClient, createFetchTransport } from "@ah-monica/core";

const client = createCoreClient({
  transport: createFetchTransport({
    dsn: process.env.MONICA_DSN!,
    auth: "secret",
  }),
  environment: process.env.NODE_ENV ?? "development",
  release: process.env.GIT_SHA,
});
```

## 使い方

`capture` は item をそのまま受け取る。`event_id` / `timestamp` / `environment` /
`release` は省略すると補われる。例外から item を組み立てる処理（stacktrace の解析、
`cause` の連鎖、mechanism の付与）は adapter 側の仕事で、この package には無い。

```ts
const eventId = await client.capture({
  type: "error",
  platform: "javascript",
  level: "error",
  message: "checkout failed",
  exception: {
    values: [{ type: "TypeError", value: "checkout failed", mechanism: { type: "generic", handled: true } }],
  },
});

const result = await client.flush(2_000);
await client.close(2_000);
```

送信そのものを差し替える場合は `MonicaTransport`（`send(envelope, signal)` が
`TransportResult` を返す）を実装して `transport` に渡す。`401` を返せば
`createFetchTransport` と同じように client が停止する。

## オプション

### `createFetchTransport(options)`

| option | 型 | default | 説明 |
| --- | --- | --- | --- |
| `dsn` | `string` | 必須 | `https://<key>@<ingest-host>`。`localhost` と `127.0.0.1` 以外は https のみ |
| `auth` | `"public" \| "secret"` | `"secret"` | `secret` は `Authorization: Bearer <key>`、`public` は `X-Monica-Key: <key>` |
| `fetch` | `typeof fetch` | `globalThis.fetch` | 送信に使う fetch。無いと `Error` |
| `maxRetries` | `number` | `5` | `429` / `5xx` / network 障害の再送回数 |
| `requestTimeoutMs` | `number` | `2000` | 1 回の HTTP request の上限 |
| `onDiagnostic` | `(diagnostic) => void \| null` | `console.warn` に 1 行 | 拒否されたときの診断の受け取り先。`null` で無効 |

### `createCoreClient(options)`

| option | 型 | default | 説明 |
| --- | --- | --- | --- |
| `transport` | `MonicaTransport` | 必須 | `createFetchTransport` の戻り値か自前実装 |
| `environment` | `string` | 必須 | 1〜128 文字。空文字は不可 |
| `release` | `string` | なし | item の `release` に載る |
| `sampleRate` | `number` | `1` | 0〜1 |
| `maxQueueSize` | `number` | `100` | queue の上限。溢れると古い item から捨てる |
| `batchSize` | `number` | `30` | 1 envelope に載せる item 数。`maxQueueSize` と 100 で頭打ち |
| `flushIntervalMs` | `number` | `5000` | queue に item がある間の自動送信間隔 |
| `beforeSend` | `(item, hint) => item \| null \| Promise<...>` | なし | `null` を返すと破棄 |
| `sdk` | `{ name, version }` | `{ name: "@ah-monica/core", version: <この package の版> }` | envelope の `sdk` |
| `now` | `() => Date` | `() => new Date()` | `timestamp` と `sent_at` に使う時刻 |
| `random` | `() => number` | `Math.random` | `sampleRate` の判定に使う乱数 |
| `generateEventId` | `() => string` | `crypto.randomUUID` | `event_id` の生成 |

`flush(timeoutMs)` と `close(timeoutMs)` の `timeoutMs` は既定 2,000 ミリ秒。

## 送信結果と診断

`flush()` / `close()` が返す `FlushResult`、`onDiagnostic` に渡る `TransportDiagnostic`、
自前 transport が返す `TransportResult` の各 field は
[TROUBLESHOOTING.md](../TROUBLESHOOTING.md) にまとめてある。

## ライセンス

[Apache-2.0](LICENSE)
