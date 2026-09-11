# monica-sdk-js

MONICA へアプリケーションのエラーを送る TypeScript / JavaScript SDK。
npm に `@ah-monica/*` として 4 package を公開している。

## パッケージ

| ディレクトリ | package | 用途・要求環境 |
| --- | --- | --- |
| [`core/`](core/README.md) | `@ah-monica/core` | ランタイム非依存の envelope 組み立て・バッファ・送信。`fetch` と `CompressionStream` があれば動く。依存なし |
| [`node/`](node/README.md) | `@ah-monica/node` | Node.js のサーバアプリケーション。Node.js 20 以上 |
| [`cloudflare/`](cloudflare/README.md) | `@ah-monica/cloudflare` | Cloudflare Workers。Node.js 互換フラグは不要 |
| [`next/`](next/README.md) | `@ah-monica/next` | Next.js App Router の client / server。Next.js 15.3 以上 17 未満、Node.js 20.9 以上 |

4 package はすべて ESM で、同じ版で一括してリリースする。
ブラウザ向けの `@ah-monica/browser` と `@ah-monica/react` は別 repository（`monica-sdk-browser`）にある。

## インストール

使う 1 つを入れる（`@ah-monica/core` は依存として一緒に入る）。

```bash
npm install @ah-monica/node        # Node.js サーバ
npm install @ah-monica/cloudflare  # Cloudflare Workers
npm install @ah-monica/next        # Next.js App Router
```

## 初期化

DSN は `https://<key>@<ingest-host>` の形式で、環境変数から渡す。
送信先は DSN の origin に `/v1/envelope` を付けたもので、DSN のパス・クエリ・フラグメントは
捨てられる。project の識別は鍵で行うので、パスに project id を書く必要はない。

```ts
import { createNodeClient } from "@ah-monica/node";

export const monica = createNodeClient({
  dsn: process.env.MONICA_DSN!,
  environment: process.env.NODE_ENV ?? "development",
  release: process.env.GIT_SHA,
});
```

鍵は 2 種類ある。

- secret key（`msk_...`）: サーバ専用。環境変数にだけ置き、ソースコード・ログ・クライアント
  配信物に含めない。`@ah-monica/node`、`@ah-monica/cloudflare`、`@ah-monica/next/server` で使う。
- public key（`mpk_...`）: クライアントに配ってよい。`@ah-monica/next/client` で使う。
  管理画面で許可 origin も設定する。

framework ごとの初期化・統合方法は各 package の README にある。

## 使い方

```ts
try {
  await runTask();
} catch (error) {
  await monica.captureException(error, { tags: { component: "worker" } });
  throw error;
}

monica.captureMessage("cache miss rate is high", "warning");
```

`captureException` / `captureMessage` は event id を返す（`sampleRate` や `beforeSend` で
落とした場合、`401` で送信が停止している場合は `null`）。イベントは queue に溜め、`batchSize` 件に達するか
`flushIntervalMs` 経過した時点でまとめて送る。`level: "fatal"` は即座に送る。
`@ah-monica/cloudflare` は queue を持たず、capture ごとに送信まで行う。

プロセスやハンドラが終わる前に、タイムアウトを指定して送信を待つ。

```ts
await monica.flush(2_000);   // 待つだけ
await monica.close(2_000);   // 以後の capture を止めてから待つ
```

`user` / `tags` / `contexts` / `breadcrumbs` / `request` / `fingerprint` は
capture の第 2 引数で渡す。`@ah-monica/node` と `@ah-monica/next` は `setUser` /
`addBreadcrumb` でクライアントに保持させることもできる。

## オプション

4 package に共通する option。

| option | 型 | default | 説明 |
| --- | --- | --- | --- |
| `dsn` | `string` | 必須 | `https://<key>@<ingest-host>`。`localhost` と `127.0.0.1` 以外は https のみ |
| `environment` | `string` | 必須 | 1〜128 文字。空文字は不可 |
| `release` | `string` | なし | item の `release` に載る |
| `sampleRate` | `number` | `1` | 0〜1。capture ごとに判定する |
| `beforeSend` | `(item, hint) => item \| null \| Promise<...>` | なし | 送信直前に item を書き換える。`null` を返すと破棄 |
| `onDiagnostic` | `(diagnostic) => void \| null` | `console.warn` に 1 行 | 拒否されたときの診断の受け取り先。`null` で無効 |
| `requestTimeoutMs` | `number` | `2000` | 1 回の HTTP request の上限 |
| `maxRetries` | `number` | `5`（`cloudflare` は `0`） | `429` / `5xx` / network 障害の再送回数 |
| `fetch` | `typeof fetch` | `globalThis.fetch` | 送信に使う fetch |

`@ah-monica/node`、`@ah-monica/next/client`、`@ah-monica/next/server` はさらに queue と
breadcrumb の option を持つ。

| option | 型 | default | 説明 |
| --- | --- | --- | --- |
| `maxQueueSize` | `number` | `100` | queue の上限。溢れると古い item から捨てる |
| `batchSize` | `number` | `30` | 1 envelope に載せる item 数。`maxQueueSize` と 100 で頭打ち |
| `flushIntervalMs` | `number` | `5000` | queue に item がある間の自動送信間隔 |
| `maxBreadcrumbs` | `number` | `50` | 保持する breadcrumb 数 |

`@ah-monica/cloudflare` 固有の option は [`cloudflare/README.md`](cloudflare/README.md)、
自前 transport を組む場合の option は [`core/README.md`](core/README.md) にある。

## 自動で収集するもの

送るのは、アプリケーションが渡した例外・メッセージと、それに付く次の値だけ。

- 例外の型・メッセージ・stacktrace（最大 200 frame）。`cause` の連鎖は最大 10 段まで辿る
- `event_id`（UUID）、`timestamp`、`level`、`platform`、`environment`、`release`
- SDK の名前と版
- `user` / `tags` / `contexts` / `breadcrumbs` / `request` / `fingerprint` のうち、
  アプリケーションが明示的に渡したもの

ただし `@ah-monica/next/server` の `onRequestError` だけは、Next.js から渡される
route の種別を `contexts.next` と `next.*` tag に足す（[`next/README.md`](next/README.md)）。
URL と headers は収集しない。

端末情報・IP・cookie・HTTP header・URL を SDK が自動で読むことはない。
どの値が個人情報かは SDK では判定せず、自動除去もしない。送る値の選択と除去は
アプリケーションの責任で、`beforeSend` がその最後の境界になる。

## 送信結果と診断

ingest が envelope を拒否すると、既定で `console.warn` に 1 行出る。出るのは `422`
（envelope の形が契約に合わない）・`401`（鍵が不正）・`413`（body が大きすぎる）の 3 つ。
出力先は `onDiagnostic` で差し替え、`null` で無効にできる。

`flush()` / `close()` が返す `FlushResult` の `status` / `issues` / `error` / `stopped` からも
同じ内容を取れる。`401` を受けると client は閉じ、以後の capture は `null` を返す。

詳しくは [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 制約

- `@ah-monica/next/client` に secret key（`msk_...`）を渡すと `TypeError` を投げる。
  クライアントに配る配信物には public key（`mpk_...`）だけを置く。
- envelope 1 件の上限は gzip 後 1 MiB、item 100 件、stacktrace 200 frame。
  SDK は送信前に JSON を 1,000,000 byte 未満に抑え、単体で超える item は破棄する。
- 送信できる item は `type: "error"` のみ。
- ESM のみ。CommonJS の `require()` では読み込めない。
- Next.js の Edge runtime は対象外。

## ライセンス

[Apache-2.0](LICENSE)

## 開発者向け

### ビルドとテスト

```bash
bun install --frozen-lockfile
bun run check            # 4 package の typecheck / test / pack:check / runtime smoke + tooling
bun run check:core       # package ごと。check:node / check:cloudflare / check:next も同じ
bun run test:contract    # 契約テストだけ
```

`bun@1.3.13`（`packageManager`）と Node.js 20 / 22 / 24 を使う。
`check:next` は実際に `next build` を回すので数分かかる。
依存を変えたら `bun.lock` も commit する（CI は `--frozen-lockfile`）。

CI は [`ci.yml`](.github/workflows/ci.yml)（PR と main への push で `bun run check` と
`bun run spec:check`、Node 20 / 22 / 24 での runtime smoke）と
[`npm-release.yml`](.github/workflows/npm-release.yml)（`v*` tag で npm 公開と GitHub release）。

### 公開契約（`spec/`）

```bash
bun run spec:check       # 配信元と一致しているか確認する
bun run spec:sync        # コピーを取り直す
```

[`spec/v1/`](spec/v1/) は手で編集しない。`spec:sync` で取り直して commit し、
契約テスト（各 package の `test/contract.test.ts`）が通ることを確かめて PR に含める。

### リリース

1. `bun run version X.Y.Z` で 4 package の `version`、package 間依存の pin、
   各 package の `src/**/version.ts` を揃える。`bun install` で `bun.lock` も更新する
2. PR で main へ merge する
3. その commit に `vX.Y.Z` tag を付けて push する。tag の版が 4 package の版と
   一致しないと workflow が落ちる
4. `core` → `node` → `cloudflare` → `next` の順に npm へ公開され、同じ tag の
   GitHub release が作られる。自動生成の notes に、利用者から見た変更（新しい API、
   既定値の変更、breaking change と移行手順）を書き足す

publish は npm の Trusted Publishing（OIDC）で行う。Trusted Publisher は package ごとに
npmjs.com 側で、この repository の `npm-release.yml` を指している必要がある。
