# 旧job通知の未投稿証明と投稿承認

Issue #238の通知生成経路。migrationで確認した`not_sent`、または`reconcile-legacy-notification --notification-reviewed --no-post-confirmed`は、過去に投稿していないという証拠だけを保存する。この証拠だけで起動scanから旧threadへ新しい通知を生成しない。

`preview-legacy-notification-post <job_id>`は1件の対象、元source event、保存済み宛先、created/terminal期間、理由、承認可能性、`preview_sha256`を返す。Result本文・path・credentialは返さない。groupedへの移行後もsingle-jobであり、既存attention/all-terminalがなく、current状態と未投稿証明が一致する候補だけが承認可能になる。受理不明、worker隔離migrationによる状態変更、別宛先、複数jobは保留する。

外部operatorがpreviewの対象・期間・理由・宛先を確認し、その旧threadへの通知生成を明示的に依頼する場合だけ、次を使用する。

```text
dona-dispatcher job approve-legacy-notification-post <job_id> <preview_sha256> <approval_id> --approve-historical-post
```

`approval_id`は16〜128文字の英数字・underscore・hyphenからなる安定した操作identityとする。CLIはprivate Dispatcher DBを操作できる同じOS userのoperator用であり、API/MCP、worker、Webへこの操作を公開しない。host approvalや本文中の「承認済み」を証拠に変換しない。

Job、source event、Result digest、宛先、group、migration/reconciliationのsnapshotへ承認を固定する。同じidentity・同じdigestはreceiptを再生し、異なる対象/digestはconflictにする。応答喪失でblind retryせず、同じidentityで保存済みreceiptを照合する。承認履歴は変更・削除しない。current snapshotが変われば新しいpreviewと承認を必要とし、過去の承認は履歴として残す。

起動scanは承認のない候補を保留し、通知生成transactionでもcurrent digestを再検査する。承認後は既存のevent idempotency、group、Agent Session、通知配送経路を使う。通知eventが生成済みなら再起動・並行scanでも同じeventへ収束する。実行中jobへの新しい明示cancelなど、旧状態とは異なる通常遷移は既存経路を維持する。

## 残るIssue全体のgate

この承認は通知eventの生成policyであり、Slack投稿の成功、current Slack access、Task操作、grant発行を証明しない。外部write直前のowner/access再検査とposted read-backは配送側の責務として残る。現行single-job legacy以外の歴史的group/schedule、release epoch policy、Updater terminal outboxとの統合と実Slackのfault検証も引き続き必要。保留候補を運用DBで承認したり、旧threadへ実際に投稿したりする作業は実行していない。

追加tableを理解しない旧binaryへのrollbackは、未投稿証明を投稿許可として扱う旧挙動へ戻るため許可しない。preserve/forward-only更新とsnapshot保持の確認を別gateにする。今回の変更でproduction activationや既存承認の推測backfillは行わない。
