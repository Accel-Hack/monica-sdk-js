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

### API key

CI 専用の secret key を発行し、その key の無受信検知を off にします。失敗したときしか送らないので、緑が 2 日続くと「SDK から 2 日以上受信が無い」Issue が立ってしまいます。

### アラートルールの例

MONICA はルールが無いと通知しません。どう通知したいかに合わせて、次の例から選んでアラートルールを作ります。項目名は管理画面の表記です。

| 運用 | 発火条件 | 設定 | 通知のされ方 |
| --- | --- | --- | --- |
| 失敗するたびに通知する | 閾値 | 集計対象: イベント、件数: 1、集計時間: `1m`、同じ通知を抑制する時間: 1 分 | 失敗のたびに通知が届き、1〜2 分後に同じ thread へ Recovered が付く |
| 失敗が続く間は 1 回だけ通知する | 閾値 | 集計対象: イベント、件数: 1、集計時間: `1h`、同じ通知を抑制する時間: 1 時間 | 最初の失敗で通知が届く。1 時間失敗が無いと Recovered が付き、その後の失敗でまた通知が届く |
| 最初の失敗だけ通知し、直したら Resolve する | 新規Issue と 再発 (ルールを 2 つ作る) | なし | 最初の失敗で通知が届く。Slack か管理画面で Resolve すると、次の失敗で再発として通知が届く。Resolve し忘れると、その job の失敗は通知されない |

どの例でも、フィルターは次のように設定します。

- 環境: default branch の失敗は `ci`、PR の失敗は `ci-pr` を指定し、ルールを分けます。通知先の Slack チャンネルも分けられます。
- 現在のIssue状態: 未解決 だけにします。flaky な job は Slack の Ignore で無視にすれば、通知が止まります。

組み合わせの一例です。

- `ci`: 失敗が続く間は 1 回だけ通知する
- `ci-pr`: 新規Issue だけ (PR の branch と job の組ごとに、最初の失敗で 1 回だけ通知する)

### 補足

- 閾値ルールの Recovered は「集計時間の間に失敗が無かった」という意味です。job が直ったことは表しません。
- 同じ通知を抑制する時間は、集計時間以下にします。長くすると、Recovered の後に来た次の通知が抑制されることがあります。
- 1 つのプロジェクトで複数の repository を受けるなら、tagフィルターに `gha.repository` を指定すると、repository ごとに通知先を分けられます。
- 夜間に止めたいときは「通知しない時間帯」を、まとめて受けたいときは「ダイジェスト間隔」(5〜60 分) を使います。
- 作ったルールは「直近イベントでテスト」で、保存済みのイベントに当てて確かめられます。通知は送られません。

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
