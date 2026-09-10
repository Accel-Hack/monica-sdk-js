# @ah-monica/core

MONICA SDK のランタイム非依存なバッファ・送信処理。通常は直接利用せず、
Node.js アプリでは `@ah-monica/node` を使う。

この package は PII を推測して自動除去しない。何を送信するか、どの値を
`beforeSend` で除去するかは利用アプリケーションが管理する。

## 拒否されたときの診断（422 の `issues`）

ingest は envelope schema に合わない envelope を `422` で破棄し、body に
どの欄が悪いかを [`error.json`](../spec/v1/error.json) の形で返す。SDK は
`429` を除く 4xx でこの body を読み（上限 64 KiB、読めなければ黙って諦める）、
`422` のときは **既定で** `console.warn` に 1 行出す。

```
monica: ingest rejected the envelope with 422 (invalid_envelope): 1 issue(s); $.items[0].request.method: Invalid type: Expected string
```

`beforeSend` で allowlist を組むと必須欄（例: `request` があるなら `method`）を
落としてしまうことがあり、この警告が無いと「送っているのに 1 件も届かない」状態に
気づけない。API key と envelope 本体はログに出さない。

出力先は `createFetchTransport` の `onDiagnostic` で差し替えられる。`null` を渡すと
何も出さない（結果に載る `issues` は残る）。

```ts
createFetchTransport({
  dsn,
  onDiagnostic(diagnostic) {
    myLogger.warn(diagnostic.message, { status: diagnostic.status, issues: diagnostic.issues });
  },
});
```

読めた内容は送信結果にも載る。`TransportResult` と `FlushResult` の
`status` / `issues` / `error` は後方互換な追加で、拒否が無ければ欄ごと現れない。

```ts
const result = await client.flush(2_000);
if (result.status === 422) {
  for (const issue of result.issues ?? []) console.log(issue.path, issue.message);
}
```

破棄・再送の判断は従来どおり HTTP status だけで行う（`error.code` では分岐しない）。
body が空・非 JSON・上限超過・`error.json` に適合しない場合も、例外を投げず
従来どおり破棄で終わる。
