import { resolveVerifiedSlackOwner } from "./verified-owner-origin.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { DispatcherDatabase } from "./database.js";
import type { EventRow } from "./types.js";

export type AgentPurpose = "human_command" | "job_completion" | "schedule_work" | "update_completion";

export interface AgentExecutionContext {
  event_id: string;
  attempt: number;
  purpose: AgentPurpose;
  tenant_id: string;
  workspace_id: string;
  principal_kind: "human";
  principal_id: string;
  expires_at: string;
  policy_revision: 1;
}

export class AgentPrincipalUnavailableError extends Error {
  readonly code = "agent_context_reauthorization_required";
  constructor() {
    super("Verified principal binding is unavailable; replay the exact Slack event through authenticated ingress before retrying");
    this.name = "AgentPrincipalUnavailableError";
  }
}

interface ActiveContext extends AgentExecutionContext { token_sha256: string; }

export const agentPurposeOperations: Record<AgentPurpose, readonly string[]> = {
  human_command: ["get_job_status_summary", "list_event_jobs", "get_job_status", "list_thread_jobs"],
  job_completion: ["list_event_jobs", "get_job_status", "plan_self_update"],
  schedule_work: [],
  update_completion: [],
};

function purpose(row: EventRow): AgentPurpose {
  if (row.source === "slack") return "human_command";
  if (row.source === "dona_job") return "job_completion";
  if (row.source === "dona_schedule") return "schedule_work";
  if (row.source === "dona_update") return "update_completion";
  throw new Error("Unsupported agent context source");
}

function verifiedPrincipal(database: DispatcherDatabase, row: EventRow) {
  return resolveVerifiedSlackOwner(database,row.event_id)?.principal;
}

export class AgentContextManager {
  private active: ActiveContext | undefined;
  private issuedAt=0;

  constructor(
    private readonly database: DispatcherDatabase,
    private readonly credentialPath: string,
    private readonly lifetimeMs = 15 * 60 * 1_000,
  ) {}

  async initialize(): Promise<void> {
    this.active = undefined;
    await fs.rm(this.credentialPath, { force: true });
  }

  async issue(row: EventRow): Promise<AgentExecutionContext> {
    const principal = verifiedPrincipal(this.database, row);
    if (!principal) throw new AgentPrincipalUnavailableError();
    const token = randomBytes(32).toString("base64url");
    const context: AgentExecutionContext = {
      event_id: row.event_id,
      attempt: row.attempt_count,
      purpose: purpose(row),
      tenant_id: principal.tenant_id,
      workspace_id: principal.workspace_id,
      principal_kind: "human",
      principal_id: principal.principal_id,
      expires_at: new Date(Date.now() + this.lifetimeMs).toISOString(),
      policy_revision: 1,
    };
    this.issuedAt=Date.now();
    this.active = { ...context, token_sha256: createHash("sha256").update(token).digest("hex") };
    await fs.mkdir(path.dirname(this.credentialPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.credentialPath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ token, event_id: context.event_id })}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.credentialPath);
    return context;
  }

  async ensure(row: EventRow): Promise<AgentExecutionContext> {
    const principal = verifiedPrincipal(this.database, row);
    if (!principal) throw new AgentPrincipalUnavailableError();
    const active = this.active;
    if (active?.event_id === row.event_id && active.attempt === row.attempt_count &&
      active.tenant_id === principal.tenant_id && active.workspace_id === principal.workspace_id &&
      active.principal_kind === principal.principal_kind && active.principal_id === principal.principal_id &&
      Date.now() >= this.issuedAt && Date.now() < Date.parse(active.expires_at)) {
      const { token_sha256: _secret, ...context } = active;
      return context;
    }
    return this.issue(row);
  }

  async revoke(eventId?: string): Promise<void> {
    if (!eventId || this.active?.event_id === eventId) this.active = undefined;
    await fs.rm(this.credentialPath, { force: true });
  }

  authorize(token: string | undefined, claimedEventId: string | undefined, operation: string, now = new Date()): AgentExecutionContext | undefined {
    const active = this.active;
    if (!active || !token || !claimedEventId || active.event_id !== claimedEventId) return undefined;
    if (!Number.isFinite(now.getTime()) || now.getTime() < this.issuedAt || now.getTime() >= Date.parse(active.expires_at) || !agentPurposeOperations[active.purpose].includes(operation)) return undefined;
    const actual = createHash("sha256").update(token).digest();
    const expected = Buffer.from(active.token_sha256, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    const current = this.database.get(active.event_id);
    if (!current || purpose(current)!==active.purpose || current.attempt_count !== active.attempt || !["dispatching", "waiting_agent", "blocked"].includes(current.status)) return undefined;
    const principal = verifiedPrincipal(this.database, current);
    if (!principal || principal.revoked_at !== null ||
      principal.tenant_id !== active.tenant_id || principal.workspace_id !== active.workspace_id ||
      principal.principal_id !== active.principal_id) return undefined;
    const { token_sha256: _secret, ...context } = active;
    return context;
  }

}
