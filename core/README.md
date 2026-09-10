# @ah-monica/core

MONICA SDK のランタイム非依存なバッファ・送信処理。通常は直接利用せず、
Node.js アプリでは `@ah-monica/node` を使う。

この package は PII を推測して自動除去しない。何を送信するか、どの値を
`beforeSend` で除去するかは利用アプリケーションが管理する。

## 拒否されたときの診断（422 の `issues`）

`429` を除く 4xx では、ingest が返す body（[`error.json`](../spec/v1/error.json)）を
読み取り上限 64 KiB で読む。body が空・非 JSON・上限超過・`error.json` に適合しない
場合は issues 無しで破棄する。`422` は既定で `console.warn` に 1 行出す。

```
monica: ingest rejected the envelope with 422 (invalid_envelope): 1 issue(s); $.items[0].request.method: Invalid type: Expected string
```

`error.code` が読めないときは `(unknown)`、`issues` が無いときは `0 issue(s)` になる。
API key と envelope 本体はログに出さない。

出力先は `createFetchTransport` の `onDiagnostic` で差し替える。既定は
`console.warn`、`null` で無効（結果の `issues` は残る）。

```ts
createFetchTransport({
  dsn,
  onDiagnostic(diagnostic) {
    myLogger.warn(diagnostic.message, { status: diagnostic.status, issues: diagnostic.issues });
  },
});
```

読めた内容は `TransportResult` と `FlushResult` の `status` / `issues` / `error`
に載る（値があるときだけ現れる）。

```ts
const result = await client.flush(2_000);
if (result.status === 422) {
  for (const issue of result.issues ?? []) console.log(issue.path, issue.message);
}
```
