import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { VerifiedAuditState } from "../audit/codec.js";
import { verifyApprovalNotificationMarker, type ApprovalNotificationKey } from "./notification-marker.js";
import { verifyApprovalExecutionMarker, type ApprovalExecutionMarkerKey } from "./execution-marker.js";
import { openSecurityReadOnlyDatabase } from "../audit/coordination.js";
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
    private readonly policies: OperationsPolicyRepository, private readonly policiesFor: (db: Database.Database) => OperationsPolicyRepository,
    private readonly markerKeys: { notification: (version: number) => ApprovalNotificationKey; execution: (version: number) => ApprovalExecutionMarkerKey }) {
    if (!policies.matchesContext(db, scope)) throw new ApprovalBackupError(); assertSynchronousCallback(policiesFor);
    assertSynchronousCallback(markerKeys.notification); assertSynchronousCallback(markerKeys.execution);
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
        this.assertSingleScope(state); verifyOpenDatabaseFile(this.db);
        if (this.db.prepare("SELECT dona_approval_metadata_backup(?)").pluck().get(target) !== 1) throw Error();
        return { instance_id: this.scope.instance_id, workspace_id: this.scope.workspace_id, binding_revision: principal.binding_revision,
          policy_revision: principal.policy_revision, clock_transaction_id: mark.previous_transaction_id, audit_sequence: state.anchor.sequence };
      });
      const fd = fs.openSync(temporary, "r"), hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
      try { fs.fsyncSync(fd); let length: number; while ((length = fs.readSync(fd, chunk, 0, chunk.length, null)) !== 0) hash.update(chunk.subarray(0, length)); }
      finally { chunk.fill(0); fs.closeSync(fd); }
      const digest = hash.digest("hex");
      fs.linkSync(temporary, destination); fs.unlinkSync(temporary); temporary = undefined;
      const parent = fs.openSync(path.dirname(destination), "r"); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      return { status: "backed_up" as const, backup_ref: "abk_" + digest, omitted_payloads: true as const, ...receipt };
    } catch { throw new ApprovalBackupError(); }
    finally { if (temporary !== undefined) fs.rmSync(temporary, { force: true }); }
  }
  private assertSingleScope(state: VerifiedAuditState, db = this.db) {
    if (state.resource_bindings.some(item => item.scope.instance_id !== this.scope.instance_id || item.scope.tenant_id !== this.scope.workspace_id)) throw Error();
    // The entire image is exported: reject unrelated application tables and all
    // foreign scoped data, including audit events with no resource commitment.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name } of tables) {
      if (!["security_audit_schema", "security_audit_records", "security_audit_checkpoint"].includes(name) && !/^approval_[a-z_]+$/.test(name)) throw Error();
    }
    for (const name of ["approval_requests", "approval_decisions", "approval_payload_metadata", "approval_supervisor_bindings", "approval_operations_policy"]) {
      if (db.prepare(`SELECT 1 FROM "${name}" WHERE instance_id IS NOT ? OR workspace_id IS NOT ? LIMIT 1`).get(this.scope.instance_id, this.scope.workspace_id)) throw Error();
    }
    if (db.prepare("SELECT 1 FROM security_audit_records WHERE json_extract(record_json,'$.event.scope.instance_id') IS NOT ? OR json_extract(record_json,'$.event.scope.tenant_id') IS NOT ? LIMIT 1")
      .get(this.scope.instance_id, this.scope.workspace_id)) throw Error();
  }
  verifyRestore(candidate: string): { status: "continuity_verified" | "needs_review"; safe_ready: false } {
    let restored: Database.Database | undefined;
    try {
      // The operator must be authorized by current state before any candidate is admitted.
      this.operations.authorizedObservation(this.policies, "restore", () => null);
      // Standalone metadata images only. Reject live WAL/hot-journal candidates
      // before SQLite can perform recovery or create a shared-memory sidecar.
      if (candidate === this.db.name || fs.statSync(candidate).ino === fs.statSync(this.db.name).ino && fs.statSync(candidate).dev === fs.statSync(this.db.name).dev
        || ["-wal", "-shm", "-journal"].some(suffix => fs.existsSync(candidate + suffix))) throw Error();
      const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), header = Buffer.alloc(20);
      try { if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length || header[18] !== 1 || header[19] !== 1) throw Error(); }
      finally { fs.closeSync(descriptor); }
      restored = openSecurityReadOnlyDatabase(candidate); restored.pragma("foreign_keys=ON"); verifyApprovalIntegrity(restored);
      if (restored.prepare("PRAGMA main.quick_check").pluck().get() !== "ok") throw Error();
      const db = restored, policies = this.policiesFor(db);
      const operations = new ApprovalOperations(db, this.providers, this.scope);
      const records = new ApprovalRecordRepository(db, this.providers.auditAnchors, this.providers.auditKeys, this.scope);
      const payloads = new ApprovalPayloadRepository(db, this.providers.auditAnchors, this.providers.auditKeys, this.scope);
      const lifecycle = new ApprovalRequestLifecycle(db, this.providers, this.scope), history = new ApprovalClockHistory(db, this.scope);
      const markers = new ApprovalExecutionMarkerStore(db, this.providers, this.scope);
      operations.authorizedObservation(policies, "restore", (state, mark) => {
        this.assertSingleScope(state, db);
        for (const kind of ["request", "decision", "consume", "execution", "notification", "event", "presentation"] as ApprovalRecordKind[]) {
          let after: string | null = null, complete = false;
          for (let page = 0; page < 1000; page++) {
            const selected = records.readListPageInState(state, { record_kind: kind, membership: "all" }, after, 100);
            for (const record of selected.records) {
              if (record.kind === "request") {
                lifecycle.verifyClock(record, mark, state);
                const payload = payloads.inspectInState(state, "request", record.row.request_id);
                if (payload !== null) {
                  const binding = payload.metadata.binding, snapshot = lifecycle.snapshot(record);
                  if (binding.owner_kind !== "request" || binding.owner_id !== record.row.request_id || binding.request_id !== record.row.request_id
                    || binding.semantic_hash !== record.row.semantic_hash || binding.created_at !== record.row.created_at
                    || "payload-store:" + binding.payload_ref !== snapshot.encrypted_content_ref
                    || binding.content.mac !== snapshot.content_hmac_sha256 || binding.content.key_version !== snapshot.content_hmac_key_version) throw Error();
                }
                if (payload?.metadata.state === "active" && payload.secret.status !== "present"
                  || requestPayloadRequired(record.row.state) && (payload?.metadata.state !== "active" || payload.secret.status !== "present")) throw Error();
              } else if (record.kind === "execution") {
                const previous = history.readInState(state, record.row.clock_transaction_id);
                if (previous === null || previous.effective_utc !== record.row.claimed_at || previous.boot_id !== mark.boot_id
                  || previous.continuous_ms > mark.continuous_ms || previous.effective_utc > mark.effective_utc) throw Error();
                const payload = payloads.inspectInState(state, "attempt", record.row.attempt_id);
                if (payload !== null) {
                  const binding = payload.metadata.binding, request = records.readInState(state, "request", record.row.request_id);
                  if (request === null) throw Error(); const snapshot = lifecycle.snapshot(request);
                  if (binding.owner_kind !== "attempt" || binding.owner_id !== record.row.attempt_id || binding.request_id !== record.row.request_id
                    || payload.metadata.consume_id !== record.row.consume_id || binding.semantic_hash !== request.row.semantic_hash
                    || binding.created_at !== record.row.claimed_at || binding.expires_at !== record.row.payload_expires_at
                    || binding.content.mac !== snapshot.content_hmac_sha256 || binding.content.key_version !== snapshot.content_hmac_key_version
                    || binding.content.signed_at !== request.row.created_at) throw Error();
                }
                if (payload?.metadata.state === "active" && payload.secret.status !== "present"
                  || record.row.state === "claimed" && (payload?.metadata.state !== "active" || payload.secret.status !== "present")) throw Error();
                const sealed = markers.readInState(state, record.row.attempt_id);
                // start前の拒否はfence 2のneeds_reviewとなり、send markerを生成しない。
                if (sealed === null && record.row.state !== "claimed"
                  && !(record.row.state === "needs_review" && record.row.fence === 2)) throw Error();
                if (sealed !== null) {
                  verifyApprovalExecutionMarker(sealed, this.markerKeys.execution(sealed.marker.key_version));
                  const sent = history.readInState(state, sealed.marker.clock_transaction_id);
                  if (sent === null || sent.effective_utc !== sealed.marker.created_at || sent.boot_id !== mark.boot_id
                    || sent.continuous_ms > mark.continuous_ms || sent.effective_utc > mark.effective_utc) throw Error();
                }
              } else if (record.kind === "decision" || record.kind === "consume" || record.kind === "notification" || record.kind === "presentation") {
                const previous = history.readInState(state, record.row.clock_transaction_id);
                const savedTime = record.kind === "decision" ? record.row.decided_at : record.kind === "consume" ? record.row.claimed_at : undefined;
                if (previous === null || savedTime !== undefined && previous.effective_utc !== savedTime
                  || previous.boot_id !== mark.boot_id || previous.continuous_ms > mark.continuous_ms || previous.effective_utc > mark.effective_utc) throw Error();
                if (record.kind === "notification") {
                  const request = records.readInState(state, "request", record.row.request_id); if (request === null) throw Error();
                  verifyApprovalNotificationMarker({ codec_version: 1, ...this.scope, request_id: record.row.request_id,
                    notification_attempt_id: record.row.notification_attempt_id, kind: record.row.kind, semantic_hash: request.row.semantic_hash,
                    created_at: previous.effective_utc, key_version: record.row.marker_key_version }, record.row.marker_mac,
                    this.markerKeys.notification(record.row.marker_key_version));
                }
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
