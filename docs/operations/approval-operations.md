# 承認運用

Issue #24の運用経路を、共有監査・保護clock・Supervisor bindingへ接続する。統合先は`integration/issue-26-supervisor-approval`であり、main統合・credential provision・署名とentitlementの配備・production enablement・live smokeはIssue #25のgateに残す。本変更でdaemonを登録したり、実Slackへ送信したりしない。

## native接続とcurrent operator

`dona-dispatcher approval-operations`は`NativeOperationsConnection`から固定のin-process Keychain CAS extension、native clock、business SQLite、独立したused-transaction SQLiteを構成する。macOS以外、設定・鍵・head・binding・policyが未配備、native artifact検証失敗の場合はsafe-offで終了する。fixtureやmemory storeへのfallback、genesisや鍵の自動生成、schema migrationの自動実行はない。

設定はowner専用の通常fileで、親directoryもsymlinkや他者の書き込みを許さない。次のfieldをstrict schemaで検証する。実credentialやprivate pathをこの文書、Result、stdoutへ記載しない。

| field | 契約 |
| --- | --- |
| `codec_version`, `enabled` | `1`、明示的な`true`。未設定・disabledは拒否 |
| `scope` | 固定`instance_id`と`workspace_id` |
| `workspace_alias`, `ledger_id` | provider aliasと保護headのledger identity |
| `database`, `used_nodes_database` | 異なるinodeの既存private SQLite絶対path |
| `evidence_directory` | owner専用のprovider custody directory |
| `access_group` | 配備された署名hostが使用できるKeychain access group |
| `audit_key_version` | 配備済み署名鍵version |
| `provider_author` | providerの`user_id`と`bot_id`。監査policyと完全一致 |
| `sweep_interval_ms`, `sweep_page_budget` | 1000〜60000ms、各collection 1〜10page/tick |

保護headは`instance_id`・`ledger_id`・purpose、binding/policy generationはscopeと別purposeへ固定する。鍵は`approval_key` itemに用途・version別で格納し、audit、content、wrap、notification marker、execution marker、provider evidenceを混用しない。marker/evidence鍵のidentityには`provider_author`も含める。別authorへ同じ鍵を再配備してsender identityを置き換えない。鍵valueはversion、purpose、state、activation/expiry、32byte secretを持ち、CLI引数・環境変数・通常設定fileから鍵を受け取らない。

native CASはembedding processのKeychain entitlementとOS real/effective UID一致を使用する。raw CASのCLIや未認証IPCを公開しない。artifact manifestはbuild整合性の確認であり、配備hostの署名・entitlement・コードasset保護の代用ではない。これらの配備証明がない間は運用を有効化しない。

schema v7のoperations policyは、共有監査root、SQL canonical bytes、保護generation、current bindingの三方向で検証する。real UIDをpolicyのprincipalへ対応させ、effective UIDも一致させる。呼び出し側のactor名は認証に使わない。`read`、`expire`、`reconcile`、`retention`、`backup`、`restore`ごとのgrantと有効期限を毎回確認する。

`OperationsPolicyOperator`による別途のprovision/変更にはcurrent bindingを満たす独立した二つの信頼済みOS-account/hardware-backed operator proofが必要になる。通常CLIからbootstrap・grant変更・署名・entitlement配備はできない。generation CAS後のDB障害は不一致をsafe-offとし、blind retryしない。binding rotation/revoke、policy revoke・期限到達・revision変更は保存済みconfirmationやcursorを無効にする。

## CLIとdry-run

共通形式は`dona-dispatcher approval-operations <action> --config <private-config>`。未知・重複flag、任意actor/outcome、相対pathを拒否する。

| action | 引数と結果 |
| --- | --- |
| `list` | `--limit 1..100`、`--state`、`--due-only`、`--cursor`。安全なhandle/state/revision投影 |
| `health`, `metrics` | current operator認可付きの件数・固定metric名 |
| `expire` | `--handle`。request revisionと期限を再照合 |
| `retention` | `--owner-kind request\|attempt --handle`。本文だけを収集 |
| `reconcile` | `--kind execution\|notification --handle --evidence <opaque-ref> --reason <8..512文字>` |
| `backup` | `--destination <private-absolute-path>`。既存fileは上書きしない |
| `restore-check` | `--candidate <private-absolute-path>`。continuity検査のみ |
| `sweep` | expiryとretentionを有界tickで継続処理するforeground loop |

write actionは既定dry-runであり、保護clock/anchorと業務状態を変更せず、confirmation digestを返す。適用時には同じintentで`--apply --confirm <digest>`を指定する。scope、policy/binding revision、対象revision/fence/metadataと保護clockから判定したexpiry eligibility、sweep設定をdigestへ結合し、単件brokerのwriter lock内でもcurrent認可を再確認する。旧confirmationを再利用しない。reasonはprocess引数になるため秘密情報を入れず、監査にはpurpose付きdigestとevidence digestの結合referenceだけを保存する。

listは1〜100件を監査付きmanifest/linkから走査した後でfilterする。空の返却pageでも`has_more`なら次cursorへ進む。cursorは認証proofではなく、scope/principal/policy/filterと監査付きmemberを毎page再照合する。部分pageを全体件数や完全な一覧と主張しない。

## provider証拠とreconcile

`SlackApprovalEvidenceProbe`は認証済みworkspace registryを再認証し、実`conversations.replies`経由でmetadataを読み取る。固定upper timestamp、`include_all_metadata`、cursorを用いて最大20page・100候補に制限する。HTTP失敗、cursor異常、重複、上限到達は完全な0件検索の代用にならない。[Slack APIのpagination契約](https://docs.slack.dev/reference/methods/conversations.replies/)に従う。

送信adapterは保存済みmarkerを`slackApprovalEvidenceMetadata`へ渡してmetadataに保持する。executionは保存済みexecution fence、notificationは一度限りの送信fence `1`を保持する。recovery後の操作fenceを送信metadataへ書き換えない。notification IDとmarker MACもimmutableに照合する。本文・時刻近接・ユーザー入力のoutcomeから成功を推測しない。

probeは実team/bot identity、messageの物理author/target、markerを署名済みcustody receiptに保存する。本文/token/private URLは投影しない。private fileのinode・mode・canonical bytes・HMAC・scope・query・author・targetをconsumerが確認する。既存opaque refは上書きしない。通常CLIはreceiptの作成/署名や配送を行わない。provider hostへの配置と鍵共有の配備確認は#25へ残る。

完全検索でexact matchが1件だけの場合に限ってaccepted/sentへ確定する。0件はunknownを維持し、複数・不完全・author/marker不一致はneeds_reviewにする。証拠file不足・署名不正・scope/旧fence不一致・operator失効は拒否する。本文TTL後も保存markerによる照合は可能だが、本文、one-shot consume、旧callback権限は復活させない。再送・再実行・automatic retryは行わない。

## sweep、retention、health

foreground sweepはtickごとにcurrent policyと保護clockを確認し、各collectionの設定page数まで処理する。SIGINT/SIGTERMで終了し、例外・clock fault・認可変更・応答不明で停止する。単件brokerのdeniedも直ちに停止し、同じtickの後続候補へ進まない。restartはcursorを捨て、監査付きstateを再走査する。重複tickは既存decision/fenceを作り直さない。常駐service登録は別の配備作業である。

retentionはowner・semantic hash・clock履歴を照合し、payloadの期限到達時にterminalな本文envelopeだけを削除する。active、needs_review、nonterminal execution、unknown/dispatch中のnotificationを保護する。metadata tombstone、request/attempt/index、consume fence、marker、共有audit/historyは保持し、削除によって再実行可能にしない。通常terminal処理で既に本文を削除した場合もtombstoneを維持する。

healthは`live`と`ready`を分離する。expiry lag、stale claim、execution/delivery unknown、needs_review、retention overdueを検証済み件数で返す。各collectionが100件を超えるなど完全検証できない場合はdegradedであり、未検証値を0へ置き換えない。clock履歴欠落、boot変更、大きなjump、監査不一致では件数も返さない。運用観測だけではexecutor/provider/runtime全体のsafe readinessを証明できないため、`ready: false`を維持する。metricsは固定名のみで、handle・body・private contextをlabelにしない。

## backupとrestore continuity

backupは単一instance/workspaceの専用DBだけを対象とし、別scopeのroot・row・監査eventや無関係なtableがある場合は拒否する。同じ認可済み監査snapshotからSQLite Online Backupを使用する。sourceをmemory SQLiteへ写し、memory内でsecret tableを空にしてVACUUMした後、metadataのみをprivate destinationへ写す。ciphertext envelopeもbackupのdiskへ一時保存しない。digestは固定サイズのchunkで計算する。元DBを変更せず、同directoryの一時fileをfsync後、上書き不可のlinkで公開する。[SQLite Online Backup](https://www.sqlite.org/backup.html)のsnapshot契約を使用する。

backupはcredential・Keychain head・used-node storeを含まず、runtimeを自動復旧するbundleではない。active本文は復元できない。`restore-check`はcurrent operator認可の後、standalone DELETE-journal形式の候補DBをread-onlyで開き、schema/FK/quick_check、同じinstance/workspace、current binding/policy generation、保護clock/boot、外部audit anchor、全record/linkとmarker continuityを有界走査する。WAL/SHM/hot journalを伴う候補は回復せずneeds_reviewへ送る。decision/consumeの保存時刻、request/attemptのpayload binding、notification/executionのMACと保持鍵も照合する。start前に拒否されたfence 2のneeds_reviewは送信markerを必須とせず、markerが存在する場合と送信済み状態では検証を省略しない。検査は候補fileやsidecarを変更せず、DB置換・anchor巻戻し・repair・再送・enablementをしない。

古いbackup、binding/boot不一致、欠落したactive本文、unknownな履歴、検証上限到達は`needs_review`と`safe_ready: false`にする。完全一致したmetadataだけでも`continuity_verified`はsafe readinessや復元完了を意味しない。復元後のunknown acceptanceと永久fenceを保持し、再配送を開始しない。安全な復元手順とlive証明は#25のruntime gateで判断する。

## 障害時の確認

writeのtimeout・切断・CAS/DB commit不一致・backup公開結果不明では同じwriteを再送しない。current監査root、clock、generation、対象revision/fence、custody receiptまたはbackup fileを読み取りで照合する。accepted/unknownを取り違えず、整合性が不明ならsafe-off/needs_reviewを保持する。外部監視SaaS、Project metadata変更、自動retryは本機能に含めない。
