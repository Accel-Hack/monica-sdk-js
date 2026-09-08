<!-- 生成物。手で編集しても次の生成で消える。
     正本は MONICA の apps/docs/src/spec/ にある。 -->

# MONICA public contract (v1)

MONICA へ event を送る SDK が守る契約。**これは生成物**で、正本は MONICA
本体にある。SDK repository はこのバンドルを vendoring したコピーを持ち、CI は
そのコピーに対して契約テストを回す。

| ファイル | 中身 |
| --- | --- |
| [`envelope.json`](./envelope.json) | envelope と error item の JSON Schema（draft 2020-12） |
| [`limits.json`](./limits.json) | envelope の上限値 |
| [`ingest.md`](./ingest.md) | Ingest API の叩き方 |
| [`payload.md`](./payload.md) | SDK が負う payload 生成義務 |
| [`vectors/envelope/`](./vectors/envelope) | envelope の test vectors。受理されるものと拒否されるもの |

配信元は `https://spec.monica.accelhack.net/v1/`。この `v1` は **Ingest API の版**
（`POST /v1/envelope`）で、バンドル自身の版ではない。v1 API
が受け付ける範囲が広がれば、このパスの中身も変わる。取得したものを
vendoring して、`ETag` で更新を確認するのが想定した使い方。

互換性を壊す変更は新しい Ingest エンドポイントの形で出るので、そのときは
別のパス（`v2/`）が隣に生えて両方が現役になる。

grouping と scrubbing のアルゴリズムはこのバンドルに入らない。SDK
はどちらも実行しないため。
