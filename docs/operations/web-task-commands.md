# 個人用Web dashboardのTask操作

ADR 0006に従い、Macが発行する端末ペアリングと現在の操作権限で認可する。OIDCの旧Web経路と個人用operatorの経路は区別する。新しい個人用Taskは保存済み `local_dashboard(instance_id, owner_id)` を所有者とし、通常のCodex workerを使う。端末IDは監査情報でありTaskの所有者ではない。

## 受付と照合

`POST /api/tasks` は `tasks:submit` を要求し、request ID・入力・event・Job（Attempt）・Task・受付receiptを同一transactionで保存する。Slack actor/eventは生成しない。同じoperatorの同じrequest IDと入力は同じreceiptへ収束し、入力が違えばconflictにする。ブラウザは送信開始前にrequest IDを保持し、応答喪失時には `GET /api/commands/{request_id}?operation=create` で照合する。新しいIDによる自動再送は行わない。

BFF再起動やsession期限で再ペアリングすると端末IDは変わるが、同一instance/operatorにMacが改めて必要な操作権限を付与した端末は、以前のreceiptを読み取れる。元の端末ID・grant revisionはreceiptの監査情報として維持する。閲覧権限だけの端末、別owner、別instance、失効済み端末には操作receiptを開示しない。旧実装で同一request IDに複数端末のreceiptが残っている場合は曖昧として停止し、推測で選ばない。

## 取消・質問・承認

取消は `POST /api/tasks/{task_id}/cancel` にrequest ID・current Attempt・revisionを渡す。現在の `tasks:cancel` とTask所有者を同じtransactionで検証する。取消の受付とworker停止完了は別であり、実行中workerは停止確認まで完了扱いしない。取消応答喪失時もreceiptを照合し、停止を自動再送しない。

質問への返答は個人用operatorが所有するTaskだけを対象とし、`tasks:submit` とexact question/current Attempt/revisionを検証する。保存した返答はdona-mainへ内部eventとして渡す。ブラウザからApp Serverのnative requestを直接操作しない。

Codex native承認は別の `approvals:native` 権限と、表示中のexact request・許可／拒否に束縛したWebAuthn確認を要求する。Slack由来Taskのnative承認もこの限定経路で扱えるが、元のTask所有者を変更せず、取消・通常の質問への権限へ拡張しない。Dona独自の外部操作承認はさらに別の `approvals:external` と既存承認台帳を使う。承認受付、実行、結果通知は別stateとして確認する。

## 旧データとrollback

旧OIDC Web Taskは `waiting / runtime_profile_unavailable` のまま保持する。新しい端末ペアリングだけで旧Taskの所有者を移行したり通常workerへ渡したりしない。Taskのない旧Jobも無条件に採用しない。旧workerの停止・所有者・保存Result・未確定の外部操作を照合する必要がある。

既存Task/Result/worktreeは削除しない。旧binaryは個人用owner、receipt、承認契約を理解しないため、新受付後の無条件rollbackはサポートしない。受付を停止し稼働workerと未確定操作を照合した上で、互換性を確認したreleaseへ戻す。DBだけの復元をworker停止や外部操作の巻戻しとみなさない。
