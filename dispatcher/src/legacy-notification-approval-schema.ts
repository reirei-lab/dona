/** Dispatcher所有の履歴保護trigger。観測したDB定義を信頼済みへ昇格しない。 */
export const legacyNotificationApprovalTriggers = ["update", "delete"].map(operation => ({
  name: `legacy_post_approval_no_${operation}`,
  tbl_name: "job_legacy_notification_post_approvals",
  sql: `CREATE TRIGGER legacy_post_approval_no_${operation} BEFORE ${operation.toUpperCase()} ON job_legacy_notification_post_approvals\n    BEGIN SELECT RAISE(ABORT,'legacy post approval is immutable'); END`,
}));
