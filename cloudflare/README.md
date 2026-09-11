# @ah-monica/cloudflare

Cloudflare Workers から MONICA へ、捕捉した例外を送る adapter。
Node.js API に依存しないので `nodejs_compat` フラグは要らない。

共通の使い方・オプション・制約は [ルートの README](../README.md) にある。

## インストール

```bash
npm install @ah-monica/cloudflare
```

## 初期化

DSN には secret key（`msk_...`）を使い、Cloudflare の secret に保存する（`vars` には置かない）。
staging と production では project・鍵・`environment` を分ける。

```ts
import { createCloudflareClient } from "@ah-monica/cloudflare";

interface Env {
  MONICA_DSN: string;
  MONICA_ENVIRONMENT: string;
  MONICA_RELEASE?: string;
}

function createClient(env: Env) {
  return createCloudflareClient({
    dsn: env.MONICA_DSN,
    environment: env.MONICA_ENVIRONMENT,
    release: env.MONICA_RELEASE,
    beforeSend(item) {
      // どの値が個人情報かはアプリケーション固有。送ってよい値だけを残す。
      delete item.user;
      if (item.request) delete item.request.headers;
      return item;
    },
  });
}
```

## 使い方

`captureException()` は capture と flush の両方を終えてから解決する Promise を返す。
handler の応答を待たせたくない場合は `captureExceptionInBackground(ctx, ...)` で
`ExecutionContext.waitUntil()` に載せる。

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      createClient(env).captureExceptionInBackground(ctx, error, {
        tags: { operation: "handle-request" },
        // URL の path にも個人情報が入り得るので、安全と判断した値だけを渡す。
        request: { method: request.method, url: new URL(request.url).origin },
      });
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
```

Cron や Queue の handler のように送信完了を処理結果に含めたい場合は、直接 `await` する。

```ts
const monica = createClient(env);
await monica.captureException(error, { tags: { trigger: "scheduled" } });
```

`captureMessage()` も同じく capture と flush を終えてから解決するので、`flush()` を
別途呼ぶ必要は無い。scope（`setUser` / `addBreadcrumb` / `withScope`）は持たず、
文脈は capture の第 2 引数で渡す。

Worker の外側で起きた未捕捉例外まで集めたい場合は Tail Worker も検討する。この adapter は、
アプリケーションが捕捉して業務上の文脈を選んで送る例外を対象にする。

## オプション

| option | 型 | default | 説明 |
| --- | --- | --- | --- |
| `dsn` | `string` | 必須 | `https://msk_...@<ingest-host>` |
| `environment` | `string` | 必須 | 1〜128 文字 |
| `release` | `string` | なし | item の `release` に載る |
| `sampleRate` | `number` | `1` | 0〜1 |
| `requestTimeoutMs` | `number` | `2000` | 1 回の HTTP request の上限 |
| `flushTimeoutMs` | `number` | `2000` | `captureException` / `captureMessage` が内部で待つ flush の上限 |
| `maxRetries` | `number` | `0` | `429` / `5xx` / network 障害の再送回数 |
| `maxCauseDepth` | `number` | `10` | 辿る `cause` の段数 |
| `maxStackFrames` | `number` | `200` | 送る stack frame 数 |
| `onDiagnostic` | `(diagnostic) => void \| null` | `console.warn` に 1 行 | 拒否されたときの診断の受け取り先。`null` で無効 |
| `beforeSend` | `(item, hint) => item \| null \| Promise<...>` | なし | `null` を返すと破棄 |
| `fetch` | `typeof fetch` | `globalThis.fetch` | 送信に使う fetch |

## 送信結果と診断

拒否されたときは既定で `console.warn` に 1 行出る（Workers のログに出る。`422` / `401` / `413`）。
`flush()` の戻り値の `status` / `issues` / `error` / `stopped` からも取れる。
詳しくは [TROUBLESHOOTING.md](../TROUBLESHOOTING.md)。

## 制約

- `captureExceptionInBackground` を使わず、`waitUntil()` にも載せずに handler を返すと、
  送信は途中で打ち切られる。
- client は request ごとに作ってよい。`401` で止まるのはその client だけなので、
  鍵が失効しても次の request で再び 1 回 POST する。

## ライセンス

[Apache-2.0](LICENSE)
