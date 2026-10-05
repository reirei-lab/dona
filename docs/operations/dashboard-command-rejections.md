# Dashboard 操作の確定拒否と受付不明

Task の依頼・取消・質問回答、native 承認、外部操作承認は、書き込み開始前に照合対象をブラウザへ保存する。応答喪失や一般的な 5xx の場合は保存した対象を維持し、receipt または status を読む。0 件でも自動再送しない。

Dispatcher が当該操作の未受理を確認できた場合だけ、private API は次の投影を返し、BFF は HTTP 409 で転送する。

```json
{"rejection":{"request_id":"照合対象ID","operation":"cancel","code":"conflict","not_committed":true}}
```

ブラウザは ID と operation が保存済み操作に一致する場合だけ照合待ちを解除する。利用者は最新の状態を確認して改めて操作できる。自動再送は行わない。

- Task コマンドでは、同期 DB transaction の rollback が確認できる検証エラーを限定して扱う。既存 receipt がある要求 ID は未受理と報告しない。
- native 承認では署名・現在の質問の照合が終わるまで判断を保存しない。同じ ceremony の二重進行を防ぎ、commit 後の wake 失敗は受付不明として receipt を照合する。
- 外部承認では署名の検証段階の拒否、service が保証した書き込み前の拒否、broker の確定 denied を未受理と扱う。判断受理後の response error は未受理へ変換しない。
- 確定拒否の応答自体が失われた場合は、未受理を推測せず照合待ちを維持する。この投影は拒否の永続 receipt ではない。
