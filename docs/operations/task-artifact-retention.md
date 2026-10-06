# Task artifactの保持と隔離cleanup基盤

[Issue #239](https://github.com/reirei-lab/dona/issues/239)の部分対応。`scripts/maintenance/task_artifact_retention.py`はlibraryであり、CLI、常駐runner、service設定、production起動経路は追加していない。現在はprivate SQLiteと一時rootのtestだけが呼び出す。Issue全体の完了・production cleanupの承認を表さない。

## 旧成果と現行契約

旧PR [#356](https://github.com/reirei-lab/dona/pull/356)は`feature/issue-231-self-update-epoch`へmergeされた旧Job inventoryのページ集計・空き容量観測で、現mainの祖先ではない。旧worktreeは正規inspectで照合し、変更していない。現mainにはTask/Attempt、App Server、通知の永続状態があるため、旧feature全体や兄弟Issueの差分は取り込まず、ページ集計・不完全な容量を完全と扱わないという契約だけを新基盤で採用した。

## 入力と保護

呼出元は管理するSQLite connection、canonicalなowner-private workspace/Result root、明示的な`Policy(retention_days, disk_floor_bytes)`を渡す。production policyの既定値はない。policy未確認、disk観測不能、root不明は削除しない。7日未満のpolicyは既存completionの7日保持より短いため拒否し、個別`content_delete_at`も満たす必要がある。testの`Policy(7, 0)`はfixture値で、運用推奨値ではない。

rootの同一性・包含関係と同じinodeのaliasを拒否する。artifactのtop-levelと各childはparentのdeviceと一致することを走査前に確認し、mount境界を越えない。実mountを操作するtestは行わず、device不一致を注入するfixtureで境界拒否を確認する。

候補は`jobs` → `task_attempts` → `tasks`のbindingで確認する。Taskと対象Attemptがterminal、他Attemptがnonterminalではない、steer/待機理由が残らない、App Serverの`state: stopped` receiptがあり、created/terminal/stop時刻の最大値から保持期限を経過していることを要求する。古いterminal時刻が新規Attemptの保持を短縮しない。terminal worker cleanupのagent名不在だけでは不足。`needs_review`、active、旧Herdr receipt、共有handoff workspaceは保護する。

schedule等のcompletion行がある場合は全行の通知が`accepted`、または固定destinationが`none`であることを確認する。通常Taskはcompletion行を生成しないため、`job_owner_bindings`の固定threadとgroup/通知eventのResultにある成功したpostおよび最後の`active`遷移を照合する。曖昧actionや宛先違いを拒否し、通知終了後もpolicyの保持期間を置く。groupのall-terminal eventの`completed`を要求し、未完了siblingも拒否する。期限・停止・通知はpurge前と再開後のwriter transaction内で再確認する。

local dashboardの固定`destination: none`にはSlack通知を要求しない。現行`LocalDashboardCommands`のcreate receipt、source event、event/job owner binding、Taskとterminal Resultの一致を照合する。閲覧確認済みとは推測せず、dashboard readerが利用する`jobs.result_json`を削除後も保持し、disk上のResult参照だけをpurgedにする。DB内contentの保持期間や閲覧ackの導入はこの版では変更しない。

Git worktreeは登録解除契約が未確定なので、関連progress/Resultも含め候補全体を保護する。この版の削除対象は独立scratch workspace、そのprogress directory、Attempt専用Result directoryだけ。

## purge、隔離、再開

`install()`は呼出元が明示的に行う専用ledger/guardの追加で、Dispatcher起動には接続していない。artifact本体・root・全祖先の実体identity、割当容量、保持状態を`task_artifact_retention`へ保存する。新規削除は`purged`をcommitしてから行い、Resultでは通常Slack Taskの`jobs.result_json`とAttempt checkpointを先に解放する。local dashboardのDB Resultは上記閲覧契約のため保持する。jobsのpath文字列は変更不可の監査資料として残し、artifact参照の状態はledgerで判定する。purged後のstatus変更、Result/checkpoint再受理、path変更はDB triggerで拒否する。

通常名を削除せず、同じparent directory handle内で専用tombstoneへ`renameatx_np(RENAME_EXCL)`する。既存tombstoneを上書きしない。全祖先を`O_NOFOLLOW`で開き、owner/type/書込modeを確認する。rename前のdev/inode/birthtime/ctimeと、削除直前のroot/parent/実体identityを再確認する。隔離後はfd相対の走査とunlink/rmdirだけを使い、symlink、hardlink、special fileを拒否する。単一candidateのunsafeはquarantinedにし、残り候補を進める。

writer transactionをboundedなfilesystem処理まで保持し、別SQLite connectionのstatus/receipt更新と削除の間に窓を作らない。process crash、response loss、entry budget到達後は`purged`の同じtombstoneだけを照合し、新しい通常名は触らない。別identityはquarantined。最終unlink後・DB commit前に失敗して実体が見えない場合は、削除完了を推測せず`purged_identity_missing`として隔離する。

再開時にもroot・祖先の保存identityを要求する。同じartifact本体を別世代のrootや祖先へ移しても再束縛しない。identityの不足する旧ledgerを削除根拠に読み替えない。

private rootと停止確認済みsubtreeを変更する正規writerはこのmaintenance処理だけという前提。同じOS userが停止receiptを偽造したり、任意の瞬間に隔離subtreeを変更したりできる脅威をOS sandboxで防ぐものではない。macOS birthtimeと排他的renameを必要とする。LinuxではPython標準statがbirthtimeを返さないため削除を拒否し、dev/inodeだけへ降格しない。

## bounded inventoryと検証

`batch()`は既定dry-run、最大8 Attemptのkeyset page、共通entry budgetとmonotonic deadlineを持つ。最大10,000 entry、64段の深さ、5秒の協調deadlineで走査を止める。OSの同期I/Oを強制中断する上限ではなく、常駐化にはchild timeout/キャンセル設計が別途必要。両root別のcapacity/floor状態と最小空き容量、件数、最古created時刻、割当容量、未計測数、cleanup errorを返し、path/Result本文を投影しない。片側でも観測不能・floor未満なら全体のfloor状態はfalseにする。ledgerのpurged時容量は現在の容量と混ぜず未計測にする。

```sh
python3 -B scripts/maintenance/test_task_artifact_retention.py -v
npm --prefix updater test
dispatcher/node_modules/.bin/tsx --test dispatcher/test/task-artifact-retention.test.ts
```

private DB/temp rootに限定したfault testはDB purge commit後のcrash、rename後のresponse loss、同名置換、削除前root/tombstone置換、tombstone衝突、budget再開、symlink/hardlink、path traversal、mode、missing、通知/期限/停止/policy不足、disk floor/観測失敗を確認する。Dispatcherの実migrationで生成したprivate DBとの互換testも含む。停止receiptと通知済み状態はfixtureであり、実App Serverの停止・実Slack配送・production削除の証拠ではない。

## 残受入と次工程

- 常駐runnerの実行頻度、最低空き容量、保護classごとの保持期間、SQLite writeの運用budgetを決定し、現在のAPI/status/metricsへledgerを接続する。通常Result終了後に強い停止receiptを発行する契約も必要。既存の名前不在cleanupを強い停止証拠に読み替えない。
- Git登録解除・共有workspace/旧Attemptのownershipと再利用禁止を決め、Git metadataとdirectory処理を整合させる。
- release/staging/migration backup/rollback/restore evidenceを現Updaterへ統合する。current/previous保護、mode差、invalid candidate隔離、partial staging、restartの実testを追加する。旧featureのrelease実装を無差別に移植しない。
- APIのpurged参照/retained summary/late Result拒否と通知groupの整合をend-to-endで検証する。運用policy決定後も、production cleanupは別途明示的な承認と実行証拠を要する。
