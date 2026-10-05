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
