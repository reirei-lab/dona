# 親Donaのworker進捗判断

関連: #274。worker bridge・ledgerは #273/#272、実Slack投稿はpresentation siblingの責務。既定の無効設定を変えず、本番有効化・Issue完了・Project Status変更は行っていない。

## 判断と適用の境界

`get_task_reports.progress_decision_candidate`は、現在eventに対応する報告、現行Attempt/desired state、Task revision/停止/steer、最大32件のdurable group membership、直前の適用済みdecisionを同じtransactionで取得して作る。workerの自由文をjob、destination、tool名、操作引数へ転用しない。

同じreportの読み直しは同じdecisionへ収束する。groupやTaskの状態が変わった場合は`eligible_now:false`となり、古いcandidateを新しい操作に適用しない。報告・質問・risk・見込み時間の入力は未信頼の資料。credential/path/URL/command-shaped内容はLLM入力候補から拒否する。意味的な秘密検査を完全に保証するものではない。

actionは`ack_internal`、`ask_worker`、`instruct_worker`、`aggregate_wait`、`report_to_user`、`ask_user`の6種類。正規化した重複、severity上昇、見込み時間の変化、無音、group内の並行報告、terminal/attentionを評価する。失敗や不完全なcontextを「問題なし」とは扱わない。

`apply_task_report_decision`はcurrent event・owner・decisionとsnapshotを照合し、適用receiptを保存する。応答を失った場合は`get_task_reports.application_receipt`を読み取り、receipt欠落を未実行の証拠として再送しない。

## workerへの操作

無音時の新しい指示は、host生成の固定した読み取り進捗確認だけを保存する。report本文のcommandやjob IDを使わず、同じdecisionの適用で指示が増えない。

questionを既存の依頼・根拠で回答できる場合、親は既存の`instruct_task`で相関answerを保存する。判断適用はその保存済みanswerへリンクし、新しい同じanswerを作らない。受理不明は既存instruction receiptを照合し、通常steerで代用しない。

## 集約とpresentation

`aggregate_wait`は30秒の期限をdurableに保存する。publisherは再起動後も期限を巡回し、現行Taskと最新報告を再検証して内部aggregate eventを一度だけqueueする。古いsnapshotのまま全件完了・投稿を決めない。pause/cancel/terminalの場合は追加eventを作らない。

`presentation_ready`は投稿済みではない。成果物はsafe projection、固定destination、deterministic operation slotを含み、投稿consumerがcurrent eligibilityとprovider receiptを照合して扱う。local dashboardのdestinationは`none`で、Slackへ転送しない。同じgroupの準備済み報告と短周期の新規進捗は重複抑止・集約待ちにする。high riskと利用者判断は見落とさない。

## 検証と残る確認

policy、API/MCP、event projection、署名済みowner、DB再起動、timer重複、pause、異なるdecision、commit前fault、応答喪失後のreceipt照合をtemp DBで検証している。

実Dona-mainでの会話評価・再接続、任意の言い換えに対するsemantic novelty、presentation consumerとの全fault/authorization matrix、実Slack、全Issue acceptanceは未確認。読み取りだけのcandidateと適用receiptを、実投稿・Task全体の完了の代わりにしない。
