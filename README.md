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

- 契約テストはコピーに対して走るのでオフラインで完結する
- パスの `v1` は Ingest API（`POST /v1/envelope`）の版で、バンドル自身の版ではない。
  v1 API が育つあいだ中身は変わってよく、どの契約でこの SDK を作ったかは git の履歴が記録している
- CI が `bun run spec:check` で配信元と比べ、食い違っていたら落ちる。
  `bun run spec:sync` でコピーを取り直して commit し、契約テストが通ることを確かめて PR に含める
- `spec/v1/` を手で編集しない。正本は MONICA 本体にあり、同期で上書きされる

### 拒否されたときの診断

`422`（envelope schema 不正）のとき、4 package は ingest が返す
[`error.json`](spec/v1/error.json) の body を読み、既定で `console.warn` に 1 行出す。
差し替え・無効化は `onDiagnostic`（既定 `console.warn`、`null` で無効）。読めた内容は
`flush()` の戻り値の `status` / `issues` / `error` から取れる。文面と欄の詳細は
[`core/README.md`](core/README.md)。

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
| [`ci.yml`](.github/workflows/ci.yml) | PR と main への push | `bun run check`、`bun run spec:check`、Node 20 / 22 / 24 での `node` / `next` の runtime smoke |
| [`npm-release.yml`](.github/workflows/npm-release.yml) | `v*` tag | 4 package を npm へ公開し、その tag の GitHub release を作成 |

## リリース

1. `bun run version X.Y.Z` で 4 package の `version`、package 間依存の pin、
   各 package の `src/**/version.ts` を同じ版にする。`bun install` で `bun.lock` も更新する。
   4 package は常に同じ版で一括リリースする（ズレは `bun run check:tooling` が落とす）
2. PR で main へ merge する
3. その commit に `vX.Y.Z` tag を付けて push する。tag の版が 4 package の版と
   一致しないと workflow が落ちる
4. 4 package の公開が済むと workflow が同じ tag の GitHub release を作る。
   notes は前の tag からの PR を並べた自動生成なので、利用者から見た変更
   （新しい API、既定値の変更、breaking change と移行手順）は後から書き足す

publish は npm の Trusted Publishing（OIDC）で行い、長期の publish token は持たない。
Trusted Publisher は package ごとに npmjs.com 側の設定で、この repository の
`npm-release.yml` を指している必要がある。公開順は `core` → `node` → `cloudflare` → `next`。

## ライセンス

[Apache-2.0](LICENSE)
