# 個人用端末からの外部操作承認

`LocalExternalApprovalService` は既存approval coreの追加transportである。新たな承認ledgerや簡易なSQLiteだけの実行許可は作らない。requestの暗号化payload、protected clock、DB外の監査anchor、decision、consume、execution marker、decision eventを既存brokerで処理する。

## 接続契約

constructorのDB connectionと `ApprovalTransactionProviders` はcaller所有とする。`ExternalApprovalAuthPort.authorize` は現在のMac grantを同期再読し、`verifyStepUp` はWebAuthn検証済みdurable receiptのinstance/owner/device/grant revision/request/decision/presentation digest/期限を照合する。これらの引数をそのまま認可証拠とみなす実装は禁止する。browserの自己申告するscopeやownerでは認可しない。

`request` は型付き `slack.post_thread_reply.v1` だけを作成する。`present` は同一draft・target・mention・期限・revisionに束縛したWeb presentationを返す。core内の `approval_card` はこのtransportではWeb presentationのopaque refであり、Slack message IDやSlack本人性を偽造しない。HTTP応答喪失だけでは承認を記録しない。`decide` は2分以内かつrequest期限内のstep-up receiptを要求する。`executePending` は保存済みdecision eventを消費し、terminal outcome後にeventをsettleする。承認受付と外部実行成功は別stateで表示する。

`local_external_contexts` は検索用の補助データであり、全authority fieldのdigestを既存監査済みrequestのbinding IDへ束縛する。補助行の変更や削除で新たな権限は作れず、照合不能なら停止する。request/execution/receiptの正本は既存coreのままとする。

## Slack provider

`LocalSlackApprovalProvider` は固定 `https://slack.com/api/` のAPIだけに接続し、credential resolverからtokenを読み取る。通常compositionは既存 `loadStoredSlackBotToken(alias, MacOSKeychainStore)` を利用する。任意URL、token、Slack actorをbrowser入力として受け取らない。

`auth.test`、`conversations.info`、全pageの `conversations.replies` でworkspace、bot、非shared targetとordered thread revisionを確認する。最大1,000 message/20 page/response 2MiBで打ち切り、不完全なsnapshotを承認対象にしない。revisionはsecret keyによるHMACとし、本文を監査metadataへ保存しない。観測は15秒以内でなければ利用しない。

送信はliteral `rich_text` と明示user mention最大3名に限定し、broadcast/special mention/unfurlを無効化する。表示したdraftと同じ内容だけを送信する。詳細は公式 [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/) と [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/) の契約による。

外部call前にcoreのexecution fenceをcommitし、そのcallで新しく `started` を得た実行者だけが送信する。credential取得後、送信直前にもgrantと期限を再検証する。timeout、切断、HTTP不明、response不一致では `acceptance_unknown` を残す。restart後は再送せず、保存済みMAC markerとexact bot/targetの全page照合だけを行う。0件は不受理と推定せずunknown、複数件はambiguousで保持する。

## 配備境界

このcomponent単体ではMac grant、WebAuthn credential、protected-store genesis/key、Slack tokenを作成しない。callerがそれぞれの実providerを接続する必要がある。in-memory fixtureをproduction providerに差し替えない。main/workerからのrequest ingressとTask/Attempt checkpointは別途server-side source契約へ結び、自由入力のsource IDから作成者権限を推測しない。実Slack投稿と本番activationは隔離テストとは別に検証する。

## Native接続と初回provision

`NativeLocalApprovalConnection` はPR #362 (`38fa061d`) のin-process native Keychain portとprotected-headの構成を再利用する。キーはpurpose/version/instance/workspace別のData Protection Keychain item、clock/auditのheadはDB外のCAS item、使用済みtransactionのimmutable nodeは専用DBへ保存する。SQLite backupの復元だけでheadやone-shot fenceを巻き戻せない。

factoryは既存Dispatcherと同じ正規DB fileを `openSecurityDatabase` で別connectionとして開く。通常の `new Database` connectionを後付け登録して回避しない。connectionはWAL、foreign_keys=ON、synchronous=FULLで使用し、native connectionをcloseしてからbusiness DBをcloseする。`NativeLocalApprovalConnection.close()` 自体はbusiness DBを閉じない。

設定は0600のcontroller-owned JSONとし、`codec_version:1`、`scope:{instance_id,workspace_id}`、`owner_id`、`ledger_id`、`access_group`、`used_nodes_database`、`slack_workspace_alias`、`key_version`を指定する。ブラウザー/MCPへpath、access group、token、keyを渡さない。aliasはoperatorが既存Slack credentialの別名として明示する。固定releaseのSlack config validatorへその1件だけを渡し、Dispatcher側の `SLACK_WORKSPACES` や別serviceのenv fileには依存しない。tokenは既存Keychainからのみ読み、providerの `auth.test` が固定workspace IDと一致する必要がある。

初回のみ、署名された実行hostの正しいKeychain access-group entitlementを配備し、Macの対話TTYでinstance/workspace/ownerのexact確認後に `provisionNativeLocalApproval(db,config,confirmation)` を実行する。通常起動・doctor・再起動からこの関数を呼ばない。native provisionは既存service domainが完全に不存在の場合のみrevision 1を一回作成し、既存headの上書き、rotationや修復には使わない。キーはprocess内で生成し、JSON設定やshell引数へ秘密を出力しない。

処理途中に失敗した場合はsafe-offのまま停止する。DB、auxiliary DB、Keychainの部分成果を照合し、同じscopeを自動削除・再生成・再試行しない。`doctor()` のreadyは現在のanchor/clock/keyを確認した結果であり、Slack接続・WebAuthn enrollment・Task実行までの成功を意味しない。boot identity変更、期限切れkey、anchor不一致、credential欠落ではready:falseを維持する。既存checkpointがあるDBへ新しいgenesisを作らない。

今回の開発でnative libraryのbuildと隔離contractテストを行うが、本番Keychain item作成、host署名変更、credential生成、実Slack投稿は行わない。

## Runtimeからの要求と継続

固定dynamic tool `dona_request_thread_reply(operation_slot, text)` はCodex 0.160.0の `item/tool/call` を使う。workspace、Slack requester、宛先、Task IDをtool入力に含めない。Runtimeがcurrent agent/generation/thread/turn/callへ束縛し、Dispatcherはworkerの登録済みAttempt binding、またはmainの受理済みevent→turn対応と保存Slack eventを照合する。同一turnに複数source対応があれば推測せず拒否する。自由入力source IDを既存MCPへ追加して認可を広げない。

`DispatcherDatabase.createExternalApprovalIngress(runtime, service, config, wake)` が本体connectionを所有するcheckpoint/outboxへ接続し、常駐laneの `tick()` で受理・実行・結果照合を進める。coreは別の保護connectionを維持する。`authorizeSource` はこのingressの現在source照合へ接続する。Slack requesterは `users.info` とbounded `conversations.members` で存在・非bot・現在membershipを確認し、Macの承認者IDへ置き換えない。

mainは暗号化requestの作成後にpending handleを受け取り、そのeventを完了できる。terminal結果は保存済みreply targetへの新しい `dona_approval` eventとする。workerは `task_external_approval_checkpoints` と同じtool callを保ち、通常のnative質問/実行承認とは混ぜない。tool responseはserverRequest/resolvedで確認するまで回答中とし、応答不明だけでTaskを再開しない。Runtime再起動で失われた未完了callはexpiredとして停止し、承認の再実行権限にしない。task cancel/pauseやAttempt置換後のsourceではconsume/sendを開始しない。

承認者はdevice/revisionを含むauthority全体のhashを監査済みdecisionのactor IDへ束縛する。補助JSONだけでauthorityを作れず、consume/start/送信直前にも現在grantを確認する。要求端末Aと承認端末Bが異なる場合もBの失効を無視しない。内部event/expiryの走査はimmutable履歴のcursorをboundedに巡回し、先頭の接続障害だけで後続要求を永久に止めない。

## 鍵更新とMac再起動後の復旧

通常起動はDB外のmaintenance manifestが `ready` で、設定のactive key versionと一致するときだけ許可する。`rotation` / `boot_recovery` の途中で停止した場合もsafe-offを維持する。Macの対話TTYから固定CLIの `rotate --next-version N` / `recover` を使い、前者は `instance/workspace/owner:rotate:N`、後者は `instance/workspace/owner:recover` をexact確認する。常駐laneを停止してin-flight処理を待ち、business/security connectionを閉じてから実施する。HTTP、MCP、通常起動から保守操作を実行しない。

`rotateNativeLocalApproval` は次の1世代だけを作り、旧keyをverification-onlyとして保持する。旧監査の検証key、used-IDと保護rootを削除しない。旧pending request、consume前のdecision、送信結果が不明なexecutionは保守監査とともにneeds_reviewへ固定し、旧payloadを消去して再送を許可しない。新keyの有効期間は89日で、期限前の保守を計画する。期限切れ後も旧keyで履歴を検証し、新audit keyで更新する正規経路を使える。

manifest更新後に設定JSONの保存だけが失敗した場合は、同じ旧設定と同じnext versionで再実行できる。manifest内のexact設定digestと完了したrotationを照合し、保護状態を書き換えず新設定を返す。異なる設定やversionへの便乗更新は拒否する。途中失敗は同じexact保守操作として人が再開し、DB/Keychainを消してやり直さない。

`recoverNativeLocalApproval` はboot identity変更を確認し、UTCを後退させず保護clockのCAS headを新bootへ移す。旧expiry、使用済みID、監査rootは保持し、旧未完了権限を失効してから受付を再開する。clock rollbackや監査anchor不一致を無条件resetで回避しない。key期限切れとboot変更が同時なら `rotate` が新keyで同じ復旧を行う。DB復元や不明な監査commitの一般的な修復手段ではない。

Runtimeの外部tool受付は常駐approval laneが `externalAvailability(true)` で更新する30秒のheartbeatを必要とする。未設定、停止、切断、heartbeat失効時の新規callは即時に利用不可として返す。`false` は新規だけを止め、既存pending要求や承認済み操作を勝手に拒否・再実行しない。

## 鍵の更新とMac再起動後の復旧

署名hostの `approval-doctor --config /absolute/config.json --database /absolute/dispatcher.sqlite` で保護状態を確認する。profile・署名・native providerが揃っていない場合はreadyを報告しない。

`approval-rotate --config ... --database ... --next-version N` はMacのTTYで対象instance/workspace/operatorと次versionを確認する。DB外のmaintenance状態で新規承認を止め、旧未完了要求を失効させ、監査を記録し、古い鍵を検証専用として保持してから次versionへ進める。設定ファイルは旧内容・inodeを照合して原子的に保存する。保護状態の更新後に設定保存が失敗した場合は同じ旧設定と同じ次versionで結果を照合でき、別versionへの盲目的な再実行を行わない。

Macのboot identityが変わった場合は `approval-recover --config ... --database ...` を使う。無条件にclockやgenesisを作り直さず、旧要求の無効化と監査を済ませ、UTC high-water・使用済みIDを保持して新bootへ移る。途中失敗はmaintenanceのまま通常受付を止め、同じ操作の状態を確認する。鍵期限切れとboot変更が重なったときは正規rotationが双方を処理する。

正常なproviderだけがRuntimeへ30秒のavailabilityを通知する。Dispatcher停止・設定不足・保護状態の不一致では新しい外部承認要求を受理せず、既存pendingを自動拒否や再送へ変換しない。通常のTask閲覧は継続できる。設定ファイルを更新した後は署名Dispatcherを再起動し、doctorと稼働releaseを照合する。
Runtimeの要求queueは本文をprocess memoryだけに置き、SQLiteの既存 `text` 列にはSHA-256 digestだけを記録する。core受理後の正本は暗号payloadである。Runtime再起動でmemoryを失ったcallはexpiredとなり、保存sourceと保護coreのbindingを照合してneeds_reviewにする。未配送notificationはaborted、開始済み不明executionはacceptance_unknownを経由し、勝手に再送しない。workerのTaskは実Runtimeを再観測し、停止確認を経た通常のAttempt回復へ進める。Donaの観測cacheはdynamic toolの引数・出力を保存しない。Codex自身の会話保存はCodex側の別storage境界であり、このqueue変更で暗号化されたとは扱わない。

常駐tickは5秒の新しい処理開始budgetと4段階の巡回順序を使う。新規要求、source再照合、executor、terminal通知の一部が遅くても、他段階と次のIDへ順番を渡す。各開始済みprovider callは固定deadlineまで完了を待ち、送信途中に中断して自動再送しない。executorもimmutable履歴cursorを処理したIDごとに進め、budgetで飛ばした後続を次回に残す。

`doctor()` がreadyの場合、全active keyの最短期限を `key_expires_at`、残り14日以内を `rotation_due` として返す。hostの署名やprovisioning profileの期限とは別に確認する。

保護payloadを導入したDBは、通常の保守reset/offline updateによる全DB snapshotの対象にできない。schema名と永続application IDを同じSQLite snapshotで検査し、payload tableをrename/drop済みでもfreelistを含む複製を拒否する。保管・照合には承認metadata専用の手順を使い、この拒否をraw file copyで回避しない。
## 個人用の運用CLI

固定署名hostの `approval-operations` modeは `operations --operation ...` を固定entryへ渡す。共通引数は `--config` / `--database`。実行中のDispatcherをquiesceしてから保守writeを行い、Mac TTYで表示された対象・結果候補・exact digestを確認する。mode/flagの入口だけを呼べるhostへ、任意JSやprovider outcomeを渡さない。

| operation | 追加引数 | 動作 |
| --- | --- | --- |
| `health` | なし | liveness、保護状態の検証可否、expiry lag、stale claim、unknown、needs_review、retention overdueの固定numeric field |
| `list` | 任意 `--cursor` / `--limit 1..100` | request ID/state/revision/expiryだけの有界page |
| `sweep` | 任意 `--apply yes` | provider不通でもrequest expiry、attempt期限、terminal本文収集を継続 |
| `retention` | `--owner-kind request\|attempt --handle` | exact metadata digestとTTL/terminal条件を再確認して本文だけ削除 |
| `reconcile` | `--handle --reason` | 保存markerを実Slack providerでread-only照合し、operator reasonのdigestと証拠を監査保存 |
| `backup` | `--destination` | 新規private metadata artifactを作成 |
| `restore-check` | `--candidate` | 候補をread-onlyで現在の保護状態へ照合 |
| `restore` | `--candidate --destination` | 一致したmetadataを新しいDBへ再構成。live DBを置換しない |

write operationは既定dry-runで、適用には `--apply yes` とそのprocessのTTY確認が必要である。reasonには秘密や本文を含めない。認可は現在のOS本人性、Mac owner、private config、保護maintenance phaseを毎回確認する。端末の自己申告や古いCLI確認値を権限にしない。healthの `live` / `verified` と `safe_ready` は別であり、この運用componentはexecutor・署名・provider配備全体のreadyを宣言しない。各collectionが100件を超えるとcountsをnullにし、部分値を全体の0件と偽らない。

常駐 `.sweep()` は有界cursorと時間budgetを使い、requestとattemptの処理順を交互にする。Slack不通でexecution側の本文TTL処理まで止めない。terminal本文を収集してもmetadata tombstone、consume、execution fence、marker、audit、used-IDを削除しない。active/needs_review/不明配送は通常retentionで保護する。期限切れの実行権限は正規の監査付きneeds_reviewへ収束し、無期限に本文TTLを延ばさない。

manual reconcileはUIの承認や新しい送信許可ではない。previewとapplyの間の失効、fence変更、保存marker不一致を拒否する。providerの0件・不完全検索はunknown、複数はambiguousのまま扱う。取得結果とreason digestは同じ監査transactionで `local_approval_operation_evidence` のcanonical digestへ束縛する。raw reason、本文、tokenは保存しない。既にneeds_reviewの結果は証拠だけ記録し、terminal requestを再開しない。応答不明後は同じwriteを再試行せず、request statusと監査済み証拠を照合する。

## metadata backupとrestoreの境界

PR #362の専用DB前提をそのまま緩めず、personal版では固定allowlistのapproval/audit tableと運用証拠だけを論理exportする。Dispatcher event/Task本文、端末credential、未知tableは対象外。`approval_payload_secrets` はDDLだけを作り、値は一時DBにもコピーしない。full-file copy、VACUUM、freed pageの転送は行わない。正規の同一SQLite snapshotとwriter coordination内で構築し、1row 2MiB、全体100,000row/256MiBで打ち切る。copy完了後に署名manifest、全recordの認証済みindex membership、payload metadata、current audit anchor/clock、instance/config digestを検証する。private temp fileをfsyncし、既存fileを上書きしないlinkで公開する。

candidateは常に `metadata_only_never_activate` である。`NativeLocalApprovalConnection` はbackup manifestのあるDBを拒否する。restoreはcandidateの署名済みanchor/clockと一致する現metadataを同じallowlist経路で新規destinationへ再構成する。candidate自体のraw copyやlive DB置換、保護head/key/used-nodeの巻戻しは行わない。古いbackup、scope/key/config/clock不一致、payload混入、sidecar付き候補、完全検証できないartifactはneeds_reviewとする。`continuity_verified` / `restored_metadata_only` は監査用metadataが一致した意味であり、過去pendingの復元・稼働再開ではない。

復旧が必要な事故ではまず受付をsafe-offにし、保護head/監査/known accepted/unknownを読み取り照合する。本体DB喪失時にmetadata backupだけで旧pendingを復活させる経路はない。履歴の調査・保全後、別途承認された新世代または正規のDB復旧計画を作る。SQLite backupだけで失われたKeychainや使用済みIDの正本を再生成しない。


## managed経路と自由文の境界

workerのDona管理下MCPは `dona_slack` / `dona_dispatcher` を無効化し、外部投稿要求はhostが実Attempt/turnへ束縛したtyped toolで受ける。承認結果イベントにはrequest IDと状態だけを渡し、exact draftをmainへ転送しない。

一般のworker Result・質問の自由文をmainが要約する場合、その意味が承認回避の代理投稿かを機械的に判別する保証はない。現在の代理投稿禁止は運用指示であり、文面heuristicによる強制や、全managed経路のprovenance強制を実装済みとは扱わない。mainの通常返信・結果通知を維持し、この残境界を理由に #20 / #21 を完了扱いしない。同一OS利用者が別途設定したclient/credentialの完全隔離も保証しない。


## 初回導入の順序と中断時の扱い

1. 署名profileとartifact doctorを確認し、まず外部承認未設定の署名Dispatcherへexact planでforward-only更新する。`/health/version`の稼働判定と外部承認readyは別であり、provision前の `external.ready:false` は更新の循環待ちを作らない。新Dispatcherが同じTask4 DBへoperator identityを初期化する。
2. そのDBの現在instance/operatorと既存Slack workspace/credential aliasを照合し、0600の承認設定を作る。未使用のused-node DB pathを指定し、空fileを事前作成しない。
3. 正規の保守手順で受付をquiesceし、進行中処理・DispatcherのDB connection終了を確認してから、署名hostのTTY `approval-provision` を使う。CLIは稼働writerの停止代行を行わない。現Task/Attemptやworkerを無確認で停止・再生成しない。
4. 本体の既存WALは検証し、security connectionごとにFULLとFKを設定・検証する。used-node DBだけは初回の単一link・0600・排他的作成を行い、WAL/FULL/FK設定とschemaの耐久検証を済ませてからKeychain key/headを作る。通常open/doctorは既存DBを作成・journal修復しない。
5. native doctor後に `DONA_LOCAL_APPROVAL_CONFIG` をinstallerへ明示して設定を保存し、Dispatcherを再起動する。機能別healthと端末のWebAuthn/承認動作を確認する。同じSHAの設定変更を新しいself-update成功と報告しない。

初回の途中失敗では、空またはschema作成途中のused-node fileも保全する。既存fileがあればprovisionは拒否し、自動unlink・再初期化・Keychain削除でやり直さない。Keychain作成より前のDB初期化失敗か、key/head/audit作成途中かを、private file metadata・schemaと正規doctorで照合する。後者や結果不明ではscopeを再発行せずsafe-offのまま保全し、個別の復旧計画を作る。前者であっても手動削除をこの手順の既定にせず、保全と照合を経た別の明示操作として扱う。metadata backupをlive DBの復旧手段にしない。

## 外部投稿とTaskの再開

外部toolのcallは、発生時にRuntimeが受理済みの`attempt:`または`steer:` operationへ固定します。同じApp Server turn内でも指示を差し替えた後に古い本文を新しい要求として扱いません。未確定steer中の要求、provenanceを持たない旧worker要求は拒否します。取消・一時停止・世代交換で未実行の承認を後継へ移植しません。

Runtimeが消失した場合、Taskの後継Attempt作成は外部checkpointの照合まで保留します。監査されたcoreが未送信と確認した要求だけは、既存のworker停止確認を経て通常のTask回復へ戻せます。実行済みの要求はrequest/receiptを後継の作業文脈へ渡し、同じ投稿を再送させません。実行結果が不明なら`external_effect_unknown`で停止し、通常のresumeやretryだけでは解除しません。保守用cacheのSQL値は解除authorityではなく、後継作成時にも現在のprotected coreを再検証します。providerや検証器が利用不能な間も安全側で保留します。

承認待ちでblockedになった後のpauseは既存Task制御の`task_human_input_pending`拒否を維持します。取消は停止確認へ進めます。保守reconcileによる事実の確認と、未確定な外部操作の再送許可は別です。新たな外部投稿には新たなexact承認が必要です。

結果不明の要求はMacの `operations --operation reconcile --handle ... --reason ...` で固定markerの投稿を照合し、exact confirmation後に監査へ記録できます。現在の監査と一致する受理証拠が確定した場合だけ、Taskは既実行のreceiptを保持して通常の停止確認後に回復します。previewだけ、unknown、矛盾するreceipt、改竄または検証できない証拠では解除しません。照合対象が見つからないだけで未送信とみなして再送する経路はありません。

## typed投稿のruntime policy照合

Issue #20の差分は既存snapshot/coreを再利用し、保存sourceのAttempt有無から期待roleを決めてRuntimeの現在roleと照合する。callerのrole指定や本文を権限根拠にしない。新規受付と保存済み要求の再観測でagent名、generation、thread、要求ID、保存turn、Attemptを照合し、workerは現在turnと受理済みoperationも固定する。mainはpending handle返却後も通常会話を続けられるため、現在turnの変更だけでは旧要求を失効させない。

| 経路 | policyと検証 |
| --- | --- |
| main通常返信・集約・結果通知 | 既存経路を維持し、追加のDona承認を要求しない |
| workerのtyped投稿 | 保存Task/Attempt、Runtimeのworker role、exact sourceを照合して既存承認coreへ渡す。未承認では送信しない |
| mainのtyped投稿 | 設定済みmain agent、Attemptなし、Runtimeのmain roleだけを受理。worker要求をmainへ付け替えない |
| callerのrole追加・別main・Attempt/role不一致 | 保存前またはingressで拒否。承認後のlive role driftも旧要求を失効させる |

canonical snapshotのsemantic hashはtarget、draftのHMAC、通知許可対象、policy/binding/resource revisionを保持する。request期限と表示revisionは既存の保護recordとcanonical Web presentation digestへ束縛する。expiryをsnapshot codecへ重複追加したり、別承認ledgerを作ったりしない。create、decision、consume、provider送信直前の既存authority再検証を維持する。

これはtyped経路の否定試験であり、任意Result本文を意味解析してmain代理投稿を機械的に検出する保証ではない。その未完境界はADR 0001のまま残す。executor側のIssue #21、統合側のIssue #25や、実Keychain・署名profile・実service・別端末・実Slackの最終gateを代替しない。providerや保護状態が未接続なら既存safe-offを維持する。
