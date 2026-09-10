# @ah-monica/cloudflare

Cloudflare WorkersからMONICAへ、捕捉した例外をbest effortで送るadapter。
Node.js APIへ依存せず、Module Workerの`ExecutionContext.waitUntil()`へ渡せる
Promiseを提供する。

```ts
import { createCloudflareClient } from "@ah-monica/cloudflare";

interface Env {
  MONICA_DSN: string;
  MONICA_ENVIRONMENT: string;
  MONICA_RELEASE?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const monica = createCloudflareClient({
        dsn: env.MONICA_DSN,
        environment: env.MONICA_ENVIRONMENT,
        release: env.MONICA_RELEASE,
        beforeSend(item) {
          // PIIの定義はアプリケーション固有。送信可能な値だけを残す。
          delete item.user;
          if (item.request) delete item.request.headers;
          return item;
        },
      });

      monica.captureExceptionInBackground(ctx, error, {
        tags: { operation: "handle-request" },
        // URL pathにもPIIが入り得るため、利用側で安全と判断した値だけを渡す。
        request: { method: request.method, url: new URL(request.url).origin },
      });
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
```

`captureException()`はcaptureとflushを完了するPromiseを返す。レスポンスを待たせたく
ないHTTP handlerでは`captureExceptionInBackground(ctx, ...)`を使う。CronやQueueの
handlerで送信完了を処理結果に含めたい場合は、直接`await`してよい。

```ts
await monica.captureException(error, { tags: { trigger: "scheduled" } });
```

## 送信が拒否されたとき

`422`（envelope schema 不正）のとき、既定で`console.warn`へ1行出す（Workersのログに出る）。

```
monica: ingest rejected the envelope with 422 (invalid_envelope): 1 issue(s); $.items[0].request.method: Invalid type: Expected string
```

出力先を変える場合は`onDiagnostic`を渡す。`null`を渡すと何も出さない。
`flush()`の戻り値の`status` / `issues` / `error`からも取得できる。

`401`（鍵の失効・種別違い）を受けると、そのclientからは以後1回もPOSTしない。
`flush()`の戻り値の`stopped: true`と次の1行で分かる。

```
monica: ingest rejected the envelope with 401 (invalid_key); no further envelopes will be sent
```

## PII方針

SDKは、例外message、stack、request、contextがPIIかどうかを推測せず、自動除去も
しない。送信値の選択と`beforeSend`での除去は利用アプリケーションの責任。
MONICAサーバの既知credentialフィルターは防御層であり、任意のPIIが除去される保証
ではない。

## API keyと環境

`dsn`にはCloudflare secretへ保存したsecret project key（`msk_...`）を使う。
stagingとproductionではproject、key、`environment`を分離し、package versionは共通で
よい。secretを`vars`、ソースコード、ログへ置かない。

未捕捉例外をWorkerの外側から網羅的に収集する用途にはTail Workerも検討する。この
adapterは、アプリケーションが捕捉し、業務contextを選んで送る例外を対象にする。
