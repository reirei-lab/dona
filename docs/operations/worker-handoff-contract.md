# App Server worker handoffの診断契約

Issue [#229](https://github.com/reirei-lab/dona/issues/229)の部分実装です。[ADR 0003](../adr/0003-self-update-epoch-cutover.md)のcompletion/epoch契約と[ADR 0004](../adr/0004-task-attempt-execution.md)のTask/current Attemptを組み合わせるための読み取りinterfaceを定義します。更新をまたぐworker継続は無効で、既存Dispatcher/Updaterのallocated worker遮断を維持します。

## 現行interface

private Runtime UDSの`POST /control`へ`{"action":"workerHandoffInventory","protocol":1}`を送ります。`RuntimeClient.workerHandoffInventory(after?)`を使用できます。旧hostの未対応action、未知protocol、照会timeoutは未検証であり、空inventoryへ置き換えません。callerが`enabled`等を送っても有効化する経路はありません。

返却値の`schema_version`と`protocol`は1、`handoff_enabled`と`activation_allowed`は常にfalse、`compatibility`は`unverified`です。空pageや停止済みworkerだけのpageもhandoff許可を証明しません。更新全体の可否は既存`updateSafetyStatus()`とUpdaterの独立DB判定を使用し、この診断値で遮断を解除しません。

`items`は最大100件で、mainを除き停止済みを含むworker記録をname順に返します。`next`がある間は`after`へ渡して巡回できます。cursorは128文字以下のASCII英数字・underscore・hyphenです。`snapshot_scope: page`は1 page内のDB read transactionを意味し、複数pageに共通する凍結watermarkではありません。巡回中のworker作成・削除・交代を安全な全inventoryとみなしてはいけません。

page内ではDB snapshotを確定してからprocess tableを一度だけ採取し、同じsampleでstatusを投影します。process sampleはDB transactionと原子的ではなく、採取後のprocess交代もあり得ます。`observed_at`は診断時刻であり、durable receiptやdrain barrierではありません。Runtimeへのread/initialize RPCさえこの呼び出しからは送らず、質問、turn、grant、DB状態を変更しません。

各項目はname、generation、config由来のattempt ID、保存済みthread/turn、state、接続の有無、process binding、request state、定型blockerだけを持ちます。config由来attempt IDはDispatcherのcurrent Attempt binding証明ではありません。`process_binding: matched`もPID/start/現在UIDの観測一致だけで、子process停止やworkload fenceの証明ではありません。process採取失敗は`unavailable`、PID/startまたはUID不一致は`mismatch`、観測した不在・zombieは`absent`です。不在からworkerの外部作用完了を推測しません。

pending/answeringとexpired requestの存在だけをcurrent generationから集計し、質問本文やexternal reply本文を返しません。過去turnのexpired requestも保守的に残るため、`expired_request_authority`は現在turnで回答可能かどうかの判定ではありません。cwd、release path、Result path、config、prompt、credential、PID/startは返しません。identityを含む内部interfaceであり、レスポンス全文をpublic healthやSlackへ転送しません。

## 未証明を維持する理由

| blocker | 必要な次の契約・証拠 |
|---|---|
| `runtime_host_strategy_unverified` | 更新中の旧host維持/新host交代、socket/owner/worker binaryの固定とforward/rollback方式 |
| `isolated_result_grant_unverified` | per-Attempt directoryに加え、実enforcement・失効・期限・generationを結合したgrant receipt。#168/#292の成果を照合して利用し、別capabilityを重ねない |
| `release_schema_pair_unverified` | exact current/target SHA、manifest、Runtime/Result reader/writer、DB/Task schema、rollback許容範囲のpair検証 |
| `terminal_owner_fence_unverified` | 旧collector凍結と新collector CAS claim、Result digest/terminal/group/event/通知dispositionのaggregate transaction |
| `same_turn_unverified` | 生存processへread-only attachした後のsame accepted turn照合。thread ID保存だけを証明としない |
| `worker_observation_unknown` / `worker_identity_mismatch` / `process_observation_unavailable` | bounded read-only照合。unknownをidle/停止へ変換せず、writeをblind retryしない |
| `waiting_unsupported` / `pending_request_unsupported` / `expired_request_authority` | 回答権限と同じrequestの継続契約。expired権限を回復せず、未対応waitingはhandoff対象外 |
| `attempt_binding_unavailable` | DispatcherのTask/current Attempt/revisionとRuntime identityの結合 |

通常TaskのCLI権限をschedule sandboxへ置換しません。per-Attempt directoryや追加write rootだけでcross-job read/write拒否を証明しません。実enforcementが未確定なら当該workerのactivationを拒否します。self-update承認はworker cancelの承認ではありません。

## 検証した部分と残るmatrix

`dispatcher/test/worker-handoff.test.ts`は、入力→Runtime UDS→inventoryまでを検証します。2個のfake Codex child、別processのRuntime host、private SQLite/temp filesystemを使い、host killのexitを確認してから新hostを起動します。workerのPID/start/generation/thread/保存turnが変わらず、新spawn、thread resume、prompt再送なしで観測できることを確認します。再接続がactive turnを証明したとは扱わず、unknownと拒否を維持します。expired質問は復旧しません。管理下fixture childだけを停止して後始末します。

unit testは100件page上限、空/停止済みpageでの拒否、DB read-only、別connectionによるgeneration競合、process採取不能/PID再利用、private値の除外を検証します。これは実Codex継続、本番grant隔離、Updaterのrelease切替、single terminal Result回収の証拠ではありません。

| 残る受入入力・故障境界 | 必須出口 |
|---|---|
| isolated running/blocked/needs_review workerと互換pair | same live process/thread/turn、prompt/stop再送0、Resultとterminal event各1。waiting未対応pairは拒否 |
| shared parent grant/legacy/未証明isolation | service停止、migration、pointer切替、worker cancel/close各0 |
| temp/fsync/rename前後・DB保存前後restart | 既存final/digestのread-back、tempをfinalと誤認しない、結果喪失/異Result上書き/再実行0 |
| quiesce/旧collector凍結/new owner claim前後、複数worker race | epoch/revision CASで旧writer commit拒否、各Attempt terminal owner1 |
| thread/turn/generation/socket/PID drift、timeout/health loss | durable証拠保持、read-only照合か隔離、blind retry0 |
| old/new releaseと旧DB/schema migration・rollback | pair拒否/互換性検証、別rollback epoch、writer解放後snapshot rollback禁止 |
| cross-job capability/symlink/traversal/revoked grant | 実enforcementによる隣接Result read/write拒否、private canary露出0 |
| Result→group→通知、late旧Attempt、受理不明steer/cancel | current Attempt fence、aggregate transaction、未送信だけ送信、曖昧writeは隔離 |

次の実装はhost方式とgrant依存の確定、durable inventory/epoch receipt、same-turn attach、単一collector、Updater forward/rollback gate接続の順です。各段階は入力から出口までprocess barrierで検証し、既定offを解除する変更を別途reviewします。実live Slack/provider、本番service/worker操作、production update/enableは別の許可と証拠が必要です。部分PRでIssue全体やMerge Readyの達成を報告しません。
