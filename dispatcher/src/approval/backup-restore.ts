import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { openSecurityDatabase } from "../audit/coordination.js";
import { assertSynchronousCallback } from "../audit/synchronous.js";
import { verifyOpenDatabaseFile } from "../audit/file-identity.js";
import { verifyApprovalIntegrity } from "./schema.js";
import { ApprovalOperations } from "./operations.js";
import type { OperationsPolicyRepository } from "./operations-policy.js";
import { ApprovalRecordRepository } from "./record-repository.js";
import { ApprovalPayloadRepository } from "./payload-repository.js";
import { ApprovalRequestLifecycle } from "./request-lifecycle.js";
import { ApprovalClockHistory } from "./clock-history.js";
import { ApprovalExecutionMarkerStore } from "./execution-marker-store.js";
import type { ApprovalRecordScope, ApprovalRecordKind } from "./record-codec.js";
import type { ApprovalTransactionProviders } from "./transaction.js";
import { requestPayloadRequired } from "./domain.js";

export class ApprovalBackupError extends Error { constructor() { super("approval_backup_unverified"); this.name = "ApprovalBackupError"; } }
/** 復元はread-only continuity検証だけ。DB copy、credential/anchor巻戻し、
 * 自動repair、再送、runtime enablementを行わない。 */
export class ApprovalBackupRestore {
  constructor(private readonly db: Database.Database, private readonly providers: ApprovalTransactionProviders,
    private readonly scope: ApprovalRecordScope, private readonly operations: ApprovalOperations,
    private readonly policies: OperationsPolicyRepository, private readonly policiesFor: (db: Database.Database) => OperationsPolicyRepository) {
    if (!policies.matchesContext(db, scope)) throw new ApprovalBackupError(); assertSynchronousCallback(policiesFor);
  }
  backup(destination: string, expectedPolicyRevision?: number) {
    let temporary: string | undefined;
    try {
      if (!path.isAbsolute(destination) || path.normalize(destination) !== destination || destination === this.db.name || fs.existsSync(destination)) throw Error();
      let directory = path.dirname(destination);
      for (;;) {
        const info = fs.lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || ![0, process.getuid?.()].includes(info.uid) || (info.mode & 0o022) !== 0
          || directory === path.dirname(destination) && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw Error();
        const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
      }
      temporary = path.join(path.dirname(destination), ".approval-backup-" + randomUUID());
      fs.closeSync(fs.openSync(temporary, "wx", 0o600));
      const target = temporary;
      const receipt = this.operations.authorizedObservation(this.policies, "backup", (state, mark, principal) => {
        if (expectedPolicyRevision !== undefined && principal.policy_revision !== expectedPolicyRevision) throw Error();
        verifyOpenDatabaseFile(this.db);
        if (this.db.prepare("SELECT dona_approval_metadata_backup(?)").pluck().get(target) !== 1) throw Error();
        return { instance_id: this.scope.instance_id, workspace_id: this.scope.workspace_id, binding_revision: principal.binding_revision,
          policy_revision: principal.policy_revision, clock_transaction_id: mark.previous_transaction_id, audit_sequence: state.anchor.sequence };
      });
      const fd = fs.openSync(temporary, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const digest = createHash("sha256").update(fs.readFileSync(temporary)).digest("hex");
      fs.linkSync(temporary, destination); fs.unlinkSync(temporary); temporary = undefined;
      const parent = fs.openSync(path.dirname(destination), "r"); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      return { status: "backed_up" as const, backup_ref: "abk_" + digest, omitted_payloads: true as const, ...receipt };
    } catch { throw new ApprovalBackupError(); }
    finally { if (temporary !== undefined) fs.rmSync(temporary, { force: true }); }
  }
  verifyRestore(candidate: string): { status: "continuity_verified" | "needs_review"; safe_ready: false } {
    let restored: Database.Database | undefined;
    try {
      // The operator must be authorized by current state before any candidate is admitted.
      this.operations.authorizedObservation(this.policies, "restore", () => null);
      restored = openSecurityDatabase(candidate); restored.pragma("foreign_keys=ON"); restored.pragma("synchronous=FULL"); verifyApprovalIntegrity(restored);
      if (restored.prepare("PRAGMA main.quick_check").pluck().get() !== "ok") throw Error();
      const db = restored, policies = this.policiesFor(db);
      const operations = new ApprovalOperations(db, this.providers, this.scope);
      const records = new ApprovalRecordRepository(db, this.providers.auditAnchors, this.providers.auditKeys, this.scope);
      const payloads = new ApprovalPayloadRepository(db, this.providers.auditAnchors, this.providers.auditKeys, this.scope);
      const lifecycle = new ApprovalRequestLifecycle(db, this.providers, this.scope), history = new ApprovalClockHistory(db, this.scope);
      const markers = new ApprovalExecutionMarkerStore(db, this.providers, this.scope);
      operations.authorizedObservation(policies, "restore", (state, mark) => {
        for (const kind of ["request", "decision", "consume", "execution", "notification", "event", "presentation"] as ApprovalRecordKind[]) {
          let after: string | null = null, complete = false;
          for (let page = 0; page < 1000; page++) {
            const selected = records.readListPageInState(state, { record_kind: kind, membership: "all" }, after, 100);
            for (const record of selected.records) {
              if (record.kind === "request") {
                lifecycle.verifyClock(record, mark, state);
                const payload = payloads.inspectInState(state, "request", record.row.request_id);
                if (payload?.metadata.state === "active" && payload.secret.status !== "present"
                  || requestPayloadRequired(record.row.state) && (payload?.metadata.state !== "active" || payload.secret.status !== "present")) throw Error();
              } else if (record.kind === "execution") {
                const previous = history.readInState(state, record.row.clock_transaction_id);
                if (previous === null || previous.effective_utc !== record.row.claimed_at || previous.boot_id !== mark.boot_id
                  || previous.continuous_ms > mark.continuous_ms || previous.effective_utc > mark.effective_utc) throw Error();
                const payload = payloads.inspectInState(state, "attempt", record.row.attempt_id);
                if (payload?.metadata.state === "active" && payload.secret.status !== "present"
                  || record.row.state === "claimed" && (payload?.metadata.state !== "active" || payload.secret.status !== "present")) throw Error();
                if (record.row.state !== "claimed" && markers.readInState(state, record.row.attempt_id) === null) throw Error();
              } else if (record.kind === "decision" || record.kind === "notification" || record.kind === "presentation") {
                const previous = history.readInState(state, record.row.clock_transaction_id);
                if (previous === null || previous.boot_id !== mark.boot_id || previous.continuous_ms > mark.continuous_ms || previous.effective_utc > mark.effective_utc) throw Error();
              }
            }
            if (!selected.has_more) { complete = true; break; }
            if (selected.next_after === null || selected.next_after === after) throw Error(); after = selected.next_after;
          }
          if (!complete) throw Error();
        }
        return null;
      });
      // Continuity alone cannot enable approval execution. #25 owns runtime readiness.
      return { status: "continuity_verified", safe_ready: false };
    } catch { return { status: "needs_review", safe_ready: false }; }
    finally { restored?.close(); }
  }
}
