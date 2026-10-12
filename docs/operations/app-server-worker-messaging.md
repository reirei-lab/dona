# App Serverのworker報告・指示bridge

Issue #273のApp Server向け接続。mainに未採用のIssue #272のledger実装（PR #278、merge commit `45a415ee7c02d4ebe6b325160b5b544299c7555e`）を採用し、既存のlease、fence、correlation、receiptを使用する。既存のTask/Attempt、native質問・実行承認、Result公開を置き換えない。

## 設定と範囲

`DONA_WORKER_MESSAGING_ENABLED=true`をDispatcherに設定する場合だけ有効になる。既定は無効。interactiveなTask workerだけにreport/status dynamic toolを追加する。既存の外部返信承認toolはworkerでも維持し、報告とは別の承認経路を通す。mainやschedule workerに報告権限を与えず、workerにSlack credentialや汎用Dispatcher MCPを渡さない。

workerは`dona_worker_report`へ`report_key`とcheckpoint/question/risk/decision_requestのpayloadを渡す。Job、Task、宛先、runtime identity、sequenceを指定できない。Runtimeが現在のstreamからAttempt/generation/thread/turnと受付順を固定し、Dispatcherはcurrent Attempt、desired state、live session bindingを再照合してledgerへ保存する。payloadはstrict schema・UTF-8上限・既知credential/URL/command/path patternで検査する。自由記述の意味的な安全性を完全に保証する検査ではないため、親は報告を未信頼の資料として扱う。

Runtime queueは未応答64件、Attemptごとの報告256件を上限とする。Dispatcher heartbeatが30秒失効すると新しい報告を受けない。受付済みの未応答RPCはhostの1秒tickで`unknown/receipt_unavailable`として解放し、workerのatomic Result公開を妨げない。受理不明を未実行と断定せず、broker復帰後は既存ledgerのcanonical receiptだけを照合してstatusを更新し、新しい報告writeやRPC二重応答を行わない。ledgerのproducer sequenceは受理時に自動付与し、Runtimeの受付順と分ける。確定拒否には安全なdiagnostic classを返し、拒否した報告が後続の連番を破綻させない。保存結果が不明な場合は拒否や未実行を推測せず、canonical receiptを再照合する。1件の観測・応答障害で他workerの報告を止めない。応答確認済み/失効済みのpayloadは30日後に消去し、内容hashとkey/receiptは照合のため残す。Reportは通常のatomic Resultやcheckpointを代替しない。

## 受理と照合

ledgerの受理receiptをRuntimeへ保存してからRPC応答を送る。workerが応答を確認した段階は`serverRequest/resolved`で区別する。同じkeyに異なる内容はconflict。同じ内容の応答喪失後は、Dispatcherがcanonical内容とruntime identityの保存済みreceiptをread-only照合する。

workerの`dona_worker_report_status`は自分のAttempt/generation/threadのkeyだけを読む。`pending`、`expired`、receiptがない状態を「未実行」とみなして再送しない。host restart、停止、切断、次turnへの変更では未応答要求を失効させる。受理済みledgerの存在とworkerへの応答確認は別の証拠である。

## 親Donaの入口

`get_task_reports(task_id, source_event_id)`は元threadとcurrent Attemptを確認し、最新20件の報告、Task revision、次の指示sequence、最新20件の指示receiptを返す。

`instruct_task(task_id, revision, message)`はanswer/add_condition/change_priorityのstrict schemaを受ける。通常の指示には元threadのSlack eventが必要。内部のworker報告eventからは、そのeventが示すquestion/decision_requestへのanswerだけを許す。answerは元message IDと次のconversation revisionへ束縛する。内部eventは永続delivery、immutable owner、署名検証済み元Slack principalを辿り、Taskの新規委任権限を取得しない。

質問待ちではTaskを`human_input`に保ち、新Attemptを自動起動しない。correlated answerのdelivery receiptと同じtransactionでJobをrunning、Taskをactiveへ戻す。signal終了では新規受付を止め、publisher/bridgeの進行中RPCをdrainしてからDBを閉じる。指示はworkerが起動するまでledgerに待機する。bridgeは同じcurrent Attempt/runtimeへ型付き入力を配送し、App Serverの既存operation journalを使用する。応答喪失後は同じoperationのreceiptをread-only照合し、`sending`/`unknown`を再送しない。workerへの受理が確定した後だけdelivery receiptを保存する。親への投入前、またはnot-sentと確定した報告eventがdead-letterになった場合だけ、同じmessageのdeliveryをbackoff付きで再配信する。prompt受理不明や親の外部操作結果不明では再配信しない。取消・停止・terminal stateが優先される。

## 状態ごとの扱い

| 状態 | worker報告 | 指示 |
| --- | --- | --- |
| queued / preparing / dispatching | Runtime要求があってもledger受理は保留 | 保存後、worker起動まで待機 |
| running | strict validation後に受理 | 元thread/current Attempt/runtimeを照合して配送 |
| blocked | 報告可能。未回答questionは1件に限定 | correlated answerの受領後に質問待ちを解除 |
| cancelling / terminal / 旧Attempt | 新規受理・外向き処理をしない | 新規配送しない。保存済みreceiptの読み取りは別扱い |

Taskのpause/cancelとruntime bindingはreceipt照会後にも再確認する。terminal/cancellingの未処理報告eventは取り出し前にsupersededとしてsettleし、処理中の親からの報告readはphase/desired stateを返して本文を開示しない。App Serverのdynamic tool spec/responseは、ローカルCLIの`app-server generate-json-schema`でもfield契約を照合した。

workerの起動環境から`DONA_*`、`SLACK_*`、`HERDR_*`とSlack tokenの既知prefixを除外する。モデル/GitHub等の元作業用認証はこのフィルターで変更しない。既存のMCP inventory経路によるDona Slack/Dispatcher serverの無効化を保持する。

local dashboard Taskも既存のcreate receiptとimmutable ownerから報告eventを作る。親の`worker_report_local` contextはそのTaskのreport read/answer専用で、汎用operator権限、Task新規委任、Slackの宛先・principalを作らない。silence eventは同じownerと現行cadence generationを検証し、新しいreportが来た後の古いsilence contextを再利用しない。

## 検証と未検証境界

`worker-report-runtime.test.ts`と`worker-report-bridge.test.ts`はtemp DB、fake App Serverの実RPC、親API、署名proofを使用し、報告受理、turnの先行完了、二重応答拒否、報告/指示の応答喪失、親の限定認可、質問待ちの再起動防止を検証する。productionのworker、Slack投稿、既存Taskは操作しない。

実Codexのdynamic tool、再接続、長時間運用、全状態/fault matrix、通常Resultとの同時実行は追加検証が必要。この接続を実環境で有効化したこと、Issue #273全体の完了、Projectの完了Statusへの遷移はこの文書からは主張しない。


## 質問待ちと指示の引継ぎ

既存のnative質問・外部承認などでblockedの場合、新しい型付きquestionは拒否し、元のwaitとattentionを保持する。先に既存waitを解消してから報告する。指示の受理不明は `external_effect_unknown` として表示し、同じruntimeの相関reportで配送を読み取り照合する。

pause中・旧Attemptの指示をclaimしない。停止確認後のAttempt交代では、受理済み未配送指示と配送済みの追加条件・優先度を元message ID・delivery state・attempt count付きで新objectiveへ一度引き継ぐ。未投入の指示は残作業に含め、投入済みか不明な指示は成果・外部操作を照合するまで再実行しない。旧deliveryはterminal fenceでsettleし、相関IDを新Attemptのanswer対象に流用しない。


## 報告eventと回答・Resultの競合

親は最新20件の履歴とは別に、現在eventに一致する `event_report` の本文を取得する。ローカルTaskの型付きquestion/decision_requestも既存dashboardの質問フォームに投影し、現行owner・device capability・Task revision・Attemptを再検証して回答receiptと相関answerを同じtransactionで保存する。承認要求はnative/external承認経路を維持し、型付き回答では代替しない。

未配送の追加指示がある間はResultを受理しない。配送後も、その指示の受理より古いcompleted_atのResultは保留し、指示を反映した新しいatomic Resultを待つ。native質問・外部承認待ちの指示はclaimせず、送信前の確定拒否を受理不明で上書きしない。
