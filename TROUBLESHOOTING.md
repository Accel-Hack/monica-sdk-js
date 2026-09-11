# トラブルシューティング

`@ah-monica/core` / `node` / `cloudflare` / `next` に共通する、送信が拒否されたときの
警告・診断・再送の挙動をまとめる。

## 警告の見方

ingest が envelope を拒否すると、既定で `console.warn` に 1 行出る（Cloudflare Workers
では Workers のログ、ブラウザでは devtools の console）。

```
monica: ingest rejected the envelope with 422 (invalid_envelope): 1 issue(s); $.items[0].request.method: Invalid type: Expected string
monica: ingest rejected the envelope with 401 (invalid_key); no further envelopes will be sent
monica: ingest rejected the envelope with 413 (unknown); splitting and resending. A size limit on the path may be below the 1 MiB (gzip) contract
```

- 既定で警告を出すのは `422`・`401`・`413` の 3 つだけ。`422` は envelope 1 件につき 1 回、
  `401` と `413` は transport につき 1 回。
- 括弧の中はレスポンス body の `error.code`。読めなかったときは `(unknown)`。
- `issues` が無いときは `0 issue(s)` で終わる。
- API key と envelope 本体は含まれない（`path` と `message` は ingest が返した検証結果そのもの）。

出力先は `onDiagnostic` で差し替える。`null` を渡すと何も出さない（`flush()` の戻り値からは
引き続き取れる）。

```ts
createNodeClient({
  dsn: process.env.MONICA_DSN!,
  environment: "production",
  onDiagnostic(diagnostic) {
    logger.warn(diagnostic.message, { status: diagnostic.status, issues: diagnostic.issues });
  },
});
```

`onDiagnostic` が例外を投げても送信結果は変わらない。retry のたびには呼ばれない。

## ingest が envelope を拒否したとき

### 422（envelope の形が契約に合わない）

envelope は破棄され、再送しない。同じ batch に載っていた他の event も一緒に落ちる。
レスポンス body の `error.issues` を読み、警告と結果に載せる。

```ts
const result = await monica.flush(2_000);
if (result.status === 422) {
  for (const issue of result.issues ?? []) console.log(issue.path, issue.message);
}
```

`path` は envelope 内の JSON path（`$.items[0].request.method` など）。該当する値を
`beforeSend` で直すか落とす。

body は 64 KiB まで読む。body が空・非 JSON・上限超過・`error.json` の形に合わない場合は
`issues` の欄ごと付かない（破棄することは変わらない）。`path` か `message` が文字列でない
issue は捨てて、読めた分だけ残す。

### 401（キーが不正・失効している）

その transport からは以後 1 回も POST しない。client も閉じ、以後の `captureException` /
`captureMessage` は `null` を返す。queue に残っていた分（停止と同時に `beforeSend` を
待っていた分も含む）は `FlushResult.discarded` に勘定される。

停止したことは `FlushResult.stopped` が `true` になることで分かる。`stopped` は一度立つと
戻らず、`status` と違って flush をまたいでも残る。

確認すること:

- サーバ（`@ah-monica/node`、`@ah-monica/cloudflare`、`@ah-monica/next/server`）は
  secret key（`msk_...`）、`@ah-monica/next/client` は public key（`mpk_...`）。
- public key は管理画面で許可 origin を設定する。
- 鍵をローテートした場合は、正しい鍵で client を作り直す。停止した client は再開しない。

`stop` を返さない自前 transport でも、`401` を返せば client は同じように止まる。

### 413（body が大きすぎる）

`items` を半分に割って送り直す（分割の境界は item）。1 件まで割っても `413` なら、その item を
破棄して `discarded` に勘定する。

分割して受理された場合でも `FlushResult.status` は `413` のままにする。SDK は送信前に
envelope の JSON を 1,000,000 byte 未満に抑えていて、契約上の上限は gzip 後 1 MiB なので、
契約どおりの ingest から `413` は返らない。返った場合は経路上の何か（proxy・gateway・WAF）が
契約より低い body 上限を持っている。

## 送信結果の受け取り

### `onDiagnostic` に渡る `TransportDiagnostic`

| field | 型 | 説明 |
| --- | --- | --- |
| `status` | `number` | ingest が返した HTTP status |
| `issues` | `TransportIssue[]` | `error.issues`。読めなければ空配列 |
| `error` | `TransportError \| undefined` | `error.code` / `error.message`。読めたときだけ |
| `message` | `string` | 既定の警告に使う 1 行 |

`TransportIssue` は `{ path: string; message: string }`、`TransportError` は
`{ code: string; message: string }`。

### `flush()` / `close()` が返す `FlushResult`

| field | 型 | 説明 |
| --- | --- | --- |
| `accepted` | `boolean` | 待っていた分をすべて送り切ったか。`401` で閉じたあとは常に `false` |
| `discarded` | `number` | 送れずに捨てた item 数 |
| `remaining` | `number` | queue に残っている item 数 |
| `status` | `number?` | 直前に受理されなかった送信の HTTP status。受理されなかった送信が無い場合と、network 障害で status が無い場合は欄ごと付かない |
| `issues` | `TransportIssue[]?` | その送信で読めた `error.issues`（実質 `422` のみ） |
| `error` | `TransportError?` | その送信で読めた `error.code` / `error.message` |
| `stopped` | `boolean?` | `401` を受けて client が閉じたあとだけ `true`。一度立つと戻らない |

`status` / `issues` / `error` は flush が返すと忘れる（次の flush には残らない）。
`stopped` だけは残る。

### 自前 transport が返す `TransportResult`

`@ah-monica/core` の `MonicaTransport` を自分で実装する場合に返す値。

| field | 型 | 説明 |
| --- | --- | --- |
| `accepted` | `boolean` | 受理されたか |
| `status` | `number?` | HTTP status。network 障害では付かない |
| `issues` | `TransportIssue[]?` | 読めた `error.issues` |
| `error` | `TransportError?` | 読めた `error.code` / `error.message` |
| `stop` | `boolean?` | `true` を返すと client が以後送信しない（`401` の `drop_and_stop`） |

## 再送・queue の挙動

status ごとの扱いは公開契約バンドルの `transport.json` に従う。

| status | 契約 | SDK の挙動 |
| --- | --- | --- |
| `202` | `accept` | queue から除去する |
| `400` | `drop` | 破棄する。再送しない |
| `401` | `drop_and_stop` | 破棄し、以後 1 回も POST しない |
| `413` | `split_and_retry` | item 単位で半分に割って送り直す。1 件でも入らなければ破棄する |
| `422` | `drop` | 破棄する。`issues` を警告と結果に載せる |
| `429` | `wait_retry_after` | `Retry-After` だけ待って再送する |
| `5xx` | `backoff` | 待って再送する |

- `Retry-After` は整数秒だけを読み、上限 60 秒。整数秒でない値は無視して backoff に落ちる。
- backoff は `min(1000 * 2^attempt, 30000)` ミリ秒に 50〜100% の jitter を掛けた待ち時間。
- 再送の上限は `maxRetries`（既定 5、`@ah-monica/cloudflare` は 0）。network 障害も同じ
  backoff で再送する。
- 1 回の HTTP request（レスポンス待ちと body 読み取り）の上限は `requestTimeoutMs`（既定 2,000 ミリ秒）。

## よくある原因と対処

**MONICA に 1 件も届かない**

- プロセスが終わる前に送信が終わっていない。終了前に `await monica.flush(2_000)` か
  `await monica.close(2_000)` を呼ぶ。
- Cloudflare Workers で送信 Promise を `ctx.waitUntil()` に渡していない。handler が返ると
  送信が打ち切られる。`captureExceptionInBackground(ctx, error)` を使う。
- `beforeSend` が `null` を返している。
- `sampleRate` を 1 未満にしている。
- `422` か `401` が出ていないか、warning を確認する。

**client の生成時に例外が出る**

- `dsn must use https except for localhost` — DSN が `https:` でない（`localhost` と
  `127.0.0.1` のみ例外）。
- `dsn must include an API key as the username` — DSN の username に鍵が入っていない。
- `client dsn must contain a public mpk_ key; never expose an msk_ key` —
  `@ah-monica/next/client` に secret key を渡している。
- `environment must not be empty` / `environment must not exceed 128 characters`。
- `sampleRate must be between 0 and 1`、`maxQueueSize must be a positive integer` などの
  `RangeError` — 該当 option の値を直す。

**大きい event が届かない**

- envelope 1 件の JSON が 1,000,000 byte を超えると SDK が item を減らして組み直し、
  単体で超える item は送信前に破棄して `discarded` に勘定する。stacktrace（最大 200 frame）
  ではなく `contexts` や `breadcrumbs` に大きい値を入れていないか確認する。

**event は届くが内容が足りない**

- `fingerprint` と `exception.values` の空配列は、envelope 全体が `422` で落ちるのを避けるため
  送信前に落とす。値を入れるか、欄ごと渡さない。
- `@ah-monica/next/server` の `onRequestError` は、Next.js から渡される URL・headers を
  収集しない。必要な値は `beforeSend` で選んで足す。
