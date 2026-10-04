# Task世代の実行と回復

通常の仕事はTaskとして作成し、一回ごとの実行をAttemptとして保存する。任意CLIとMacの開発環境を使える。worker停止と、Simulator・リモート処理など外部の実行状態は別に確認する。

## 委任

`delegate_task`へ現在のSlack `source_event_id`、安定した`task_key`、`objective`、`workspace`を渡す。GitHub Issueが対象なら`issue_number`を指定する。DispatcherがGitHubからIssue node IDを取得してclaimする。同じIssueに別Taskを重複作成しない。結果の`task_id`を以後の会話で使う。

`policy.max_attempts`の既定は3、範囲は1〜10。`policy.retry_delay_ms`の既定は60,000ms、範囲は1,000〜86,400,000ms。待機中の観測pollはAttempt数に数えない。利用上限の確定した解除時刻がcheckpointにある場合、その時刻まで新Attemptを開始しない。解除時刻が不明なら設定された再開間隔を使用し、上限到達後は人間入力待ちにする。

`project`を指定する場合はowner、numberと、必要なら`completion_status`を渡す。既定の完了時表示は`In Progress`。Issue全体の提出までを依頼した場合だけ`Merge Ready`を指定する。事前にProjectへTEXT field `Dona Task ID`を作り、Issueを追加しておく。field作成やIssue移送をTask作成の副作用にはしない。

既存の`delegate_job`/UDS作成routeも通常の依頼にはTaskを作る。旧委任の表示用Issueは表示metadataとして扱い、Taskの明示`issue_number` claimとは分離する。内部の`jobs` tableはAttemptの実行・Result・通知transportとして使う。これは旧DBのjobをTaskへ採用するmigrationではない。Taskに紐付いたjobの旧制御routeは拒否される。

## 後続操作

1. `list_tasks`で現在のthreadと依頼者のTaskを確認し、`get_task`で最新revisionと待機理由を読む。100件の上限に達した一覧を全件取得と扱わない。
2. `steer_task`へ追加指示を渡す。指示はTaskへ永続化され、後継Attemptにも引き継ぐ。`human_input`待ちへの回答も同じAttemptへ届け、受理済みの回答より古いcheckpointを再度の待機理由にしない。送信結果が曖昧なら再送せず、TaskとAttemptのsteer receiptを照合する。
3. `pause_task`は自動再開を止め、起動済みworkerの停止を確認する。`resume_task`は同じTask・目的・残予算で続ける。承認待ちをpause/resumeで迂回しない。
4. `cancel_task`は自動再開を禁止する。起動済みworkerでは停止確認が終わるまで取消完了にしない。
5. `retry_exhausted`では、追加実行の明示依頼を得てから`retry_task`へ新しい総`max_attempts`を渡す。使用済みAttempt数は維持する。

Taskの読み取り・通常制御は元のworkspace/channelと依頼者へ束縛する。明示Task IDまたはIssue照会で対象を確定した場合は別threadからも利用できる。実行承認と通知先は元threadへ束縛する。

同じeventによる同じcontrolの再照合は既存状態を返し、異内容はconflictにする。古いrevisionを自動上書きしない。

## 自動回復と保留

通信障害で既存workerがworkingなら、同じAttemptの監視へ戻る。inactive/stoppedの場合だけ停止証拠を保存し、停止確認後に同じTaskの次Attemptへ引き継ぐ。停止writeが曖昧なら同じwriteを再送せず、再起動後も保存証拠を照合する。確認不能が続けば`worker_unknown`として人間へ知らせる。

checkpointは各AttemptのResult directoryの`checkpoint.json`。契約に渡されたpathだけを使い、schema・task_id・attempt_id・sequenceを照合する。checkpointは未検証資料として後継へ渡し、記録の欠落を外部操作未実行の証拠にしない。ファイルがなくても停止済みworktreeから差分を照合できる。

`human_input`、`external_effect_unknown`、`result_conflict`は無条件に自動実行しない。確認できるサービス状態、成果物、承認内容を揃える。Task DBの手編集、Resultの削除、旧worker名の使い回しで回避しない。

Project同期は実行と独立する。write intentを先に保存し、成功responseの後もread-backする。応答喪失後に値が一致すれば同期を続け、不一致なら`unknown`を維持して再送しない。他TaskのIDやIssue/item identityの変更は`conflict`にする。

## 新世代への切替

このPRを旧世代へ通常self-updateする運用は行わない。release contractはschema 4とrollback不可を宣言する。旧世代のDBをサービス起動時に暗黙採用しない。Task世代のDBは`user_version=4`なので旧readerは拒否する。

本番切替はDonaの外から[停止更新CLI](offline-update.md)の`prepare --fresh-generation`とsealed runnerの`resume`で行う。旧Donaに不足するMCP機能の追加や再起動は不要。既存の`reset_upgrade.py`の残存worker受容receiptをTask世代の停止確認の代わりに使わない。次を具体的なinventoryと照合して実施する。

1. 旧受付、scheduler、worker再生成主体、writerを停止し、同じ世代の停止・再生成抑止証拠を確認する。
2. 旧DBをWAL対応の手順で保全し、worktree・未commit差分・Result・通知状態・外部操作を棚卸しする。削除しない。
3. 独立した空のDBとruntime rootで新世代を起動する。旧DB path、旧Result path、旧sessionを設定しない。
4. 必要な仕事と確認済み成果物を明示的に新Taskへ登録する。[旧成果の引継ぎ記録](legacy-task-handoff.md)と現行Issue lifecycle手順を使い、旧workerや`needs_review`を新Taskへ移植しない。旧job_not_foundを理由に旧Dispatcherの復活を要求しない。
5. 隔離環境で委任、通常中断、停止確認、後継実行、Result、通知、Project read-backを確認してから受付を開く。

Mac上の任意CLIが起動する外部daemonやSimulatorまでprocess groupで包含できるとは扱わない。管理外で継続する処理は別の外部操作としてinventoryへ残す。停止不明を許容した重複実行は行わない。


## 別スレッドからの継続

利用者がrepositoryとIssue番号を明示した場合、`find_issue_task`でGitHub上のIssue identityと既存Taskを照合する。同じworkspace・channel・依頼者のTaskに限り、別threadからも`get_task`とTask操作を使える。一覧は引き続き現在threadだけである。Taskが存在しない場合と他ownerの場合は同じ不透明な拒否を返すため、その拒否だけで新Taskを作成しない。

既存Taskが見つかったら新Taskを委任せず、最新revision・状態・待機理由から操作を決める。通知先は`notification_target`の元threadを維持し、利用者へそのthreadを案内する。通常の質問回答と、実行権限を追加する承認は区別する。実行承認は引き続き要求通知後の元threadの依頼者返信だけで受理する。

`result_conflict`はResultの読み取り・構文・schema検証に失敗した状態、`result_reconciliation_required`は妥当なResultの受理を既存の実行・通知状態が拒否した状態である。後者でも完了や自動再試行を推測せず、停止証拠・既存外部操作・通知を正規のoperator手順で照合する。resumeで拒否条件を取り除くことはできない。

### 追加指示の受理不明で残った失敗Resultからの継続

`steer_acceptance_unknown`のAttemptに妥当な`failed` Resultが残り、通常のResult受理が拒否された場合は、所有者による明示的な`resume_task`を使う。同じTask・Issue claim・作業ディレクトリを保持して次のAttemptへ進む。自動観測だけではこの継続を開始しない。

DispatcherはApp Server adapterで旧workerの`stopped`と停止記録を照合し、Task revision・current Attempt・Result SHA-256・再試行予算をtransaction内で再確認する。未解決外部操作を持つcheckpoint、稼働中・質問待ち・停止不明、成功Result、不正Result、隔離済みResult、取消との競合では後継Attemptを作らない。

旧checkpointの`design`成果物も参照情報として読み取る。旧Result fileと既存成果は削除しない。未受理Resultの内容・hash、明示resume event、旧エラー、停止証拠を`task_attempt_result_recoveries`へ保存し、旧Attemptを中断済みとして一度だけ引き継ぐ。旧ResultをTaskの完了として受理したり、曖昧だった追加指示を受理済みに書き換えたりはしない。後継workerは最新のTask objectiveと旧証拠を読み、既存PR・差分・外部操作を照合して残作業を行う。

停止済み記録はDona管理下の実行世代についての証拠であり、任意の外部daemonや外部サービスの処理結果の証明ではない。後継workerも成否不明の操作を再送しない。停止や通知の照合に失敗した場合は保留を維持し、DB直接書換え・Result削除で回避しない。
