import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type Database from "better-sqlite3";
import { openSecurityDatabase } from "../audit/coordination.js";
import { NativeKeychainPort } from "./native-keychain-port.js";
import { encodeKeychainCasRequest, parseKeychainCasResponse, type KeychainCasScope } from "./keychain-cas.js";
import { ProtectedClockMarks, ProtectedAuditAnchors, type ProtectedHeadPort, type ProtectedHeadEntry } from "./protected-heads.js";
import { SqliteUsedTransactionNodes } from "./used-transaction-store.js";
import { NativeClockSource } from "./native-clock.js";
import { KeychainBindingGenerations, SupervisorBindingRepository, SupervisorBindingGuard } from "./supervisor-binding.js";
import { OperationsPolicyRepository } from "./operations-policy.js";
import { operationsCanonical } from "./operations-policy.js";
import { ApprovalOperations } from "./operations.js";
import { ApprovalDecisionBroker } from "./decision-broker.js";
import { ApprovalRequestLifecycle } from "./request-lifecycle.js";
import { ApprovalExecutionBroker } from "./execution-broker.js";
import { ApprovalNotificationBroker } from "./notification-broker.js";
import { DurableProviderEvidence, OperationsReconcileAuthority, type ProviderEvidenceKey } from "./provider-evidence.js";
import type { ApprovalTransactionProviders } from "./transaction.js";
import type { AuditKey } from "../audit/codec.js";
import type { ApprovalPayloadKey } from "./payload-protection.js";
import type { ApprovalNotificationKey } from "./notification-marker.js";
import type { ApprovalExecutionMarkerKey } from "./execution-marker.js";
import type { ExecutionCommand } from "./execution-authority.js";
import type { NotificationCommand } from "./notification-authority.js";
import { ApprovalRetention } from "./retention.js";
import { ApprovalBackupRestore } from "./backup-restore.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const filename = z.string().max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value);
const configSchema = z.strictObject({ codec_version: z.literal(1), enabled: z.literal(true),
  scope: z.strictObject({ instance_id: id, workspace_id: id }), workspace_alias: id, ledger_id: id,
  database: filename, used_nodes_database: filename, evidence_directory: filename,
  access_group: z.string().regex(/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/), audit_key_version: positive,
  provider_author: z.strictObject({ user_id: id, bot_id: id }),
  sweep_interval_ms: z.number().int().min(1000).max(60000), sweep_page_budget: z.number().int().min(1).max(10) });
export type OperationsConnectionConfig = z.infer<typeof configSchema>;
export function readOperationsConfig(filenameInput: string): OperationsConnectionConfig {
  try {
    filename.parse(filenameInput);
    let ancestor = path.dirname(filenameInput);
    for (;;) {
      const info = fs.lstatSync(ancestor);
      if (!info.isDirectory() || info.isSymbolicLink() || ![0, process.getuid?.()].includes(info.uid) || (info.mode & 0o022) !== 0) throw Error();
      const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
    }
    const info = fs.lstatSync(filenameInput);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16384) throw Error();
    const fd = fs.openSync(filenameInput, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd); if (opened.dev !== info.dev || opened.ino !== info.ino) throw Error();
      return configSchema.parse(JSON.parse(fs.readFileSync(fd, "utf8")));
    } finally { fs.closeSync(fd); }
  } catch { throw Error("approval_operations_configuration_unavailable"); }
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
class KeychainHeadPort implements ProtectedHeadPort {
  constructor(private readonly port: NativeKeychainPort, private readonly scope: KeychainCasScope) {}
  read(): ProtectedHeadEntry {
    const response = parseKeychainCasResponse(this.port.exchange(encodeKeychainCasRequest(this.scope)));
    if (response.status !== "observed") throw Error("approval_protected_head_unavailable");
    return { revision: response.revision, value: Buffer.from(response.value, "base64").toString("utf8") };
  }
  compareExchange(expected: ProtectedHeadEntry, proposed: string): ProtectedHeadEntry {
    const response = parseKeychainCasResponse(this.port.exchange(encodeKeychainCasRequest(this.scope,
      { revision: expected.revision, value: Buffer.from(expected.value) }, Buffer.from(proposed))));
    if (response.status !== "changed") throw Error("approval_protected_head_unavailable");
    return { revision: response.revision, value: Buffer.from(response.value, "base64").toString("utf8") };
  }
}
const keySchema = z.strictObject({ codec_version: z.literal(1), version: positive,
  purpose: z.enum(["audit", "approval_content", "approval_payload_wrap", "approval_notification_marker", "approval_execution_marker", "approval_provider_evidence"]),
  state: z.enum(["active", "verification_only", "revoked"]), activated_at: z.iso.datetime(), signing_expires_at: z.iso.datetime(),
  secret_hex: z.string().regex(/^[a-f0-9]{64}$/) });
/** 用途/versionごとのprovision済みKeychain itemを読むだけ。秘密鍵を設定file・
 * 環境変数・CLI引数へ入れず、鍵やgenesisを自動作成しない。 */
class NativeApprovalKeys {
  constructor(private readonly port: NativeKeychainPort, private readonly config: OperationsConnectionConfig) {}
  read<P extends z.infer<typeof keySchema>["purpose"]>(purpose: P, version: number) {
    const identity = [this.config.scope, purpose, version,
      ...(["approval_notification_marker", "approval_execution_marker", "approval_provider_evidence"].includes(purpose) ? [this.config.provider_author] : [])];
    const response = parseKeychainCasResponse(this.port.exchange(encodeKeychainCasRequest({ access_group: this.config.access_group,
      instance_id: "key_" + digest(identity), purpose: "approval_key" })));
    if (response.status !== "observed") throw Error("approval_key_unavailable");
    const key = keySchema.parse(JSON.parse(Buffer.from(response.value, "base64").toString("utf8")));
    if (key.purpose !== purpose || key.version !== version) throw Error("approval_key_unavailable");
    return { purpose, version, state: key.state, activated_at: key.activated_at, signing_expires_at: key.signing_expires_at,
      secret: Buffer.from(key.secret_hex, "hex") };
  }
}

/** 実native providersを構成するローカルfrontend。構成やcredentialが不明なら
 * constructorでsafe-offになり、fixtureやmemory storeへfallbackしない。 */
export class NativeOperationsConnection {
  readonly db: Database.Database;
  readonly providers: ApprovalTransactionProviders;
  readonly policies: OperationsPolicyRepository;
  readonly operations: ApprovalOperations;
  readonly expiry: ApprovalDecisionBroker;
  readonly retention: ApprovalRetention;
  readonly recovery: ApprovalBackupRestore;
  readonly config: OperationsConnectionConfig;
  private readonly nodesDb: Database.Database;
  private readonly native: NativeKeychainPort;
  private readonly keys: NativeApprovalKeys;
  private readonly guard: SupervisorBindingGuard;
  constructor(configFilename: string) {
    const opened: { close(): void }[] = [];
    try {
      this.config = readOperationsConfig(configFilename);
      if (this.config.database === this.config.used_nodes_database) throw Error();
      this.native = new NativeKeychainPort(); opened.push(this.native);
      this.db = openSecurityDatabase(this.config.database); opened.push(this.db); this.db.pragma("foreign_keys=ON"); this.db.pragma("synchronous=FULL");
      this.nodesDb = openSecurityDatabase(this.config.used_nodes_database); opened.push(this.nodesDb);
      this.nodesDb.pragma("synchronous=FULL");
      const business = fs.statSync(this.config.database), auxiliary = fs.statSync(this.config.used_nodes_database);
      if (business.dev === auxiliary.dev && business.ino === auxiliary.ino) throw Error();
      const nodes = new SqliteUsedTransactionNodes(this.nodesDb), scope = this.config.scope;
      const head = (purpose: "clock_mark" | "audit_anchor") => {
        const identity = { instance_id: scope.instance_id, ledger_id: this.config.ledger_id, purpose };
        const port = new KeychainHeadPort(this.native, { access_group: this.config.access_group,
          instance_id: "head_" + digest(identity), purpose });
        return { identity, port };
      };
      this.keys = new NativeApprovalKeys(this.native, this.config);
      const clock = head("clock_mark"), audit = head("audit_anchor");
      this.providers = { clock: new NativeClockSource(), clockMarks: new ProtectedClockMarks(clock.identity, clock.port, nodes),
        auditAnchors: new ProtectedAuditAnchors(audit.identity, audit.port, nodes), auditKeys: version => this.keys.read("audit", version) as AuditKey,
        auditSigningKeyVersion: this.config.audit_key_version, maximumClockDriftMs: 5000, lockWaitTimeoutMs: 1000 };
      const binding = new SupervisorBindingRepository(this.db, this.providers.auditAnchors, this.providers.auditKeys, scope,
        new KeychainBindingGenerations(scope, this.config.access_group, this.native));
      this.policies = new OperationsPolicyRepository(this.db, this.providers, scope, binding,
        new KeychainBindingGenerations(scope, this.config.access_group, this.native, "policy_generation"));
      if (operationsCanonical(this.policies.read()?.provider_author) !== operationsCanonical(this.config.provider_author)) throw Error();
      // Opsはdecision/dispatchを許可しない。reconcileは別のcurrent operator authorityで行う。
      this.guard = new SupervisorBindingGuard(binding, this.config.workspace_alias, () => { throw Error("approval_dispatch_disabled"); });
      this.retention = new ApprovalRetention(this.db, this.providers, scope, this.policies);
      this.operations = new ApprovalOperations(this.db, this.providers, scope, undefined, (state, mark) => this.retention.countInState(state, mark));
      this.expiry = new ApprovalDecisionBroker(this.db, this.providers, scope, () => ({ status: "denied", reason: "unauthorized" }),
        version => this.keys.read("approval_content", version) as ApprovalPayloadKey,
        version => this.keys.read("approval_payload_wrap", version) as ApprovalPayloadKey,
        version => this.keys.read("approval_notification_marker", version) as ApprovalNotificationKey, this.guard, this.policies);
      this.recovery = new ApprovalBackupRestore(this.db, this.providers, scope, this.operations, this.policies, candidate => {
        const candidateBinding = new SupervisorBindingRepository(candidate, this.providers.auditAnchors, this.providers.auditKeys, scope,
          new KeychainBindingGenerations(scope, this.config.access_group, this.native));
        return new OperationsPolicyRepository(candidate, this.providers, scope, candidateBinding,
          new KeychainBindingGenerations(scope, this.config.access_group, this.native, "policy_generation"));
      });
      this.operations.authorizedObservation(this.policies, "read", () => null);
    } catch {
      for (const resource of opened.reverse()) { try { resource.close(); } catch { /* preserve redaction */ } }
      throw Error("approval_operations_safe_off");
    }
  }
  reconcile(kind: "execution" | "notification", input: ExecutionCommand | NotificationCommand, reason: string, transactionId: string, expectedPolicyRevision: number) {
    const authority = new OperationsReconcileAuthority(this.policies,
      new DurableProviderEvidence(this.config.evidence_directory, version => this.keys.read("approval_provider_evidence", version) as ProviderEvidenceKey),
      new ApprovalRequestLifecycle(this.db, this.providers, this.config.scope), reason, this.config.provider_author, expectedPolicyRevision);
    const content = (version: number) => this.keys.read("approval_content", version) as ApprovalPayloadKey;
    const wrapping = (version: number) => this.keys.read("approval_payload_wrap", version) as ApprovalPayloadKey;
    const denied = () => ({ status: "denied" as const, reason: "unauthorized" as const });
    if (kind === "execution") return new ApprovalExecutionBroker(this.db, this.providers, this.config.scope, denied, denied, authority.execution,
      content, wrapping, version => this.keys.read("approval_execution_marker", positive.parse(version)) as ApprovalExecutionMarkerKey, this.guard)
      .resolve(transactionId, input as ExecutionCommand);
    return new ApprovalNotificationBroker(this.db, this.providers, this.config.scope, denied, denied, authority.notification,
      content, wrapping, version => this.keys.read("approval_notification_marker", version) as ApprovalNotificationKey, this.guard)
      .resolve(transactionId, input as NotificationCommand);
  }
  close(): void { this.db.close(); this.nodesDb.close(); this.native.close(); }
}
