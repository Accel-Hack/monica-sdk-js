# monica-sdk-js

MONICA へアプリケーションのエラーを送る TypeScript / JavaScript SDK。
npm の `@ah-monica/*` として公開している 4 package の正本。

| ディレクトリ | package | 用途 |
| --- | --- | --- |
| [`core/`](core/) | `@ah-monica/core` | ランタイム非依存の envelope 組み立て・バッファ・送信。依存なし |
| [`node/`](node/) | `@ah-monica/node` | Node.js 20+ のサーバ向け。`core` に依存 |
| [`cloudflare/`](cloudflare/) | `@ah-monica/cloudflare` | Cloudflare Workers 向け。`core` に依存 |
| [`next/`](next/) | `@ah-monica/next` | Next.js App Router の client / server 向け。`core` と `node` に依存 |

ブラウザ向け（`@ah-monica/browser`、`@ah-monica/react`）は別 repository
（`monica-sdk-browser`）にあり、この repository の `@ah-monica/core` を npm 公開版で参照する。

使い方は各 package の README にある。

## 公開契約バンドル（`spec/`）

MONICA へ送る envelope の形、上限値、Ingest API の叩き方は、MONICA 本体が生成して
`https://spec.monica.accelhack.net/v1/` で配信している**公開契約バンドル**が決める。
この repository は [`spec/v1/`](spec/v1/) にそのコピーを vendoring して持ち、
各 package の `test/contract.test.ts` がコピーに対して契約テストを回す。

- 契約テストはオフラインで完結する。fork からの PR も手元の clone もそのまま通る
- パスの `v1` は Ingest API（`POST /v1/envelope`）の版で、バンドル自身の版ではない。
  v1 API が育つあいだ中身は変わってよく、どの契約でこの SDK を作ったかは git の履歴が記録している
- コピーの更新は [`spec-sync.yml`](.github/workflows/spec-sync.yml) が平日朝に配信元を取得し、
  違っていれば新しいコピーで契約テストを回して結果を本文に書いた PR を出す。
  手元で確かめるなら `bun run spec:check`、更新するなら `bun run spec:sync`
- `spec/v1/` を手で編集しない。正本は MONICA 本体にあり、同期で上書きされる

## 開発

```bash
bun install --frozen-lockfile
bun run check            # 4 package の typecheck / test / pack:check / runtime smoke + tooling
bun run check:core       # package ごと。check:node / check:cloudflare / check:next も同じ
bun run test:contract    # 契約テストだけ
```

要求する版は `bun@1.3.13`（`packageManager`）、Node.js 20 / 22 / 24。
`next` の runtime smoke は実際に `next build` を回すので数分かかる。

依存を変えたら `bun.lock` も commit する。CI は `--frozen-lockfile` で入れる。

## CI

| workflow | いつ | 何をするか |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | PR と main への push | `bun run check` と、Node 20 / 22 / 24 での `node` / `next` の runtime smoke |
| [`spec-sync.yml`](.github/workflows/spec-sync.yml) | 平日 09:00 JST と手動 | 公開契約バンドルの差分検査と同期 PR |
| [`npm-release.yml`](.github/workflows/npm-release.yml) | `npm-v*` tag | 4 package を npm へ公開 |

## リリース

1. 4 package の `version` と、package 間の依存（`node` → `core`、`cloudflare` → `core`、
   `next` → `core` / `node`）を同じ版に上げる。各 adapter が envelope の `sdk.version` に
   書く値も同じ版にする（テストが package.json と照合する）
2. PR で main へ merge する
3. その commit に `npm-vX.Y.Z` tag を付けて push する。tag の版が 4 package の版と
   一致しないと workflow が落ちる

publish は npm の Trusted Publishing（OIDC）で行い、長期の publish token は持たない。
Trusted Publisher は package ごとに npmjs.com 側の設定で、この repository の
`npm-release.yml` を指している必要がある。公開順は `core` → `node` → `cloudflare` → `next`。

## ライセンス

[Apache-2.0](LICENSE)
