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

設定は0600のcontroller-owned JSONとし、`codec_version:1`、`scope:{instance_id,workspace_id}`、`owner_id`、`ledger_id`、`access_group`、`used_nodes_database`、`slack_workspace_alias`、`key_version`を指定する。ブラウザー/MCPへpath、access group、token、keyを渡さない。aliasは既存workspace registryに一致し、providerの `auth.test` が固定workspace IDと一致する必要がある。

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
