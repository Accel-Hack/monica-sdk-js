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

## status ごとの挙動（`transport.json`）

| status | action | この SDK の挙動 |
| --- | --- | --- |
| `202` | `accept` | queue から除去する |
| `400` | `drop` | 破棄する。再送しない |
| `401` | `drop_and_stop` | 破棄し、以後 1 回も POST しない（下記） |
| `413` | `split_and_retry` | item 単位で半分に割って送り直す。1 件でも入らなければ破棄する |
| `422` | `drop` | 破棄する。`issues` を警告と結果に載せる（上記） |
| `429` | `wait_retry_after` | `Retry-After`（整数秒、上限 60 秒）だけ待って再送する |
| `5xx` | `backoff` | `min(1000 * 2^attempt, 30000)` ミリ秒に 50〜100% の jitter を掛けて再送する |

### 401 で送信を止める

`401` を受けると transport はそれ以降 POST せず、client は閉じる。以後の `capture` は
`null` を返し、queue に残っていた分は `discarded` に勘定される。止めたことは既定で
1 回だけ警告し、`FlushResult.stopped` でも分かる。

```
monica: ingest rejected the envelope with 401 (invalid_key); no further envelopes will be sent
```

送信を再開するには、正しい鍵で client を組み直す。

### 413 で分割する

送信前に、JSON が 1,000,000 byte を超える envelope は SDK 側で分割し、1 件でも
超えるものは破棄する。それでも `413` が返った場合は `items` を半分に割って送り直す
（分割の境界は item）。1 件まで割っても `413` ならその item を破棄して `discarded` に
勘定する。
