# @ah-monica/core

MONICA SDK のランタイム非依存なバッファ・送信処理。通常は直接利用せず、
Node.js アプリでは `@ah-monica/node` を使う。

この package は PII を推測して自動除去しない。何を送信するか、どの値を
`beforeSend` で除去するかは利用アプリケーションが管理する。
