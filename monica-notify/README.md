# monica-notify

GitHub Actions の job が失敗したとき、失敗した job 1 件につき 1 件のエラーを MONICA に送る reusable workflow です。

## 呼び出し方

監視したい workflow に次の job を足します。

```yaml
  notify-monica:
    needs: [build, test]   # 監視したい job をすべて並べる
    if: failure()
    permissions:
      actions: read
      contents: read
    uses: Accel-Hack/monica-sdk-js/.github/workflows/monica-notify.yml@main
    secrets:
      MONICA_CI_DSN: ${{ secrets.MONICA_CI_DSN }}
```

- secret は org で共通にせず、呼び出す repository ごとに作ります。その repository の secret `MONICA_CI_DSN` に、MONICA の secret key (`msk_`) の DSN を入れておきます。
- `needs` に書き忘れた job は拾えません。その job だけが失敗したときは `failure()` が偽になり、notify job が動きません。
- `on: workflow_run` で起動した workflow から呼ぶと、起動元の run の失敗を送ります。

## 送る内容

- conclusion が `failure` か `timed_out` の job 1 件につき 1 event を送ります。cancelled の job は送りません。
- 本文は失敗した step のログ末尾 100 行です (64 KiB 上限)。タイムスタンプと ANSI エスケープは取り除きます。失敗した step が分からないときは job ログ全体の末尾を送ります。
- Issue のタイトルは `<repo> <workflow> / <job> (<PR 番号か branch>): <失敗した step> <job の URL>` です。
- environment は default branch への push や schedule なら `ci`、PR とそれ以外の branch なら `ci-pr` です。release は commit SHA です。
- fingerprint は repo・workflow path・job 名・branch です。同じ branch で同じ job が失敗し続けると、1 つの Issue にまとまります。
- event_id は job id から決めています。notify job を再実行しても MONICA は同じ event を二重に数えません。
- tag は `gha.repository` `gha.workflow` `gha.job` `gha.event` `gha.branch` です。PR のときは `gha.pull_request` も付けます。

## MONICA 側の設定

CI 専用の secret key を発行し、その key の無受信検知を off にします。失敗したときしか送らないので、緑が 2 日続くと「SDK から 2 日以上受信が無い」Issue が立ってしまいます。

alert rule の例です。どちらも条件に issue status = unresolved を入れます。

| environment | rule |
| --- | --- |
| `ci` | threshold で events ≥ 1、window 1h、throttle は window 以下 |
| `ci-pr` | new_issue |

threshold rule の Recovered は「window の間に失敗が無かった」という意味でしかありません。直ったことの確認には使えません。

## 制約

- script は常に `main` から取得します。main への merge は全 repo に即時に効きます。ほかの package と違い、tag での release も npm への公開もしません。
- fork からの PR には secret が渡らないので、何も送りません。warning を出して成功で終わります。
- MONICA が受け取らなかったとき (4xx、リトライ後の 5xx、30 秒のタイムアウト) は notify job が失敗します。

## 開発

```sh
cd monica-notify
npm ci
npm test
```

`build.mjs` は I/O を持たない純粋な関数で、`index.mjs` が環境変数・GitHub API・MONICA への送信を受け持ちます。
