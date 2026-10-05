import type Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

export const operatorCapabilities = ["tasks:read", "conversations:worker:read", "conversations:main:read",
  "tasks:submit", "tasks:cancel", "approvals:native", "approvals:external"] as const;
export type OperatorCapability = typeof operatorCapabilities[number];
const capabilitiesSchema = z.array(z.enum(operatorCapabilities)).min(1).max(operatorCapabilities.length)
  .refine(values => new Set(values).size === values.length);
export interface OperatorAuthority {
  instance_id: string; owner_id: string; device_id: string; grant_revision: number;
}
interface DeviceRow { device_id: string; capabilities_json: string; revision: number; active: number; created_at: string }
interface Session { device_id: string; revision: number; csrf: string; deadline: number; enrollmentDeadline: number; expires_at: string }
export interface OperatorSession extends OperatorAuthority {
  capabilities: OperatorCapability[]; csrf: string; expires_at: string;
}
export class OperatorAuthError extends Error {
  constructor(readonly code: "denied" | "invalid" | "conflict" | "limit") { super(`operator_auth_${code}`); }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const opaque = (prefix: string) => prefix + randomUUID().replaceAll("-", "");

/** The host operator administers this registry through a private UDS only.
 * Browser sessions and pairing codes are process-local: restart or restore
 * never resurrects a previously issued cookie. Device grants are durable. */
export class OperatorAuthRegistry {
  private readonly sessions = new Map<string, Session>();
  private pairing: { digest: string; capabilities: OperatorCapability[]; deadline: number } | undefined;
  private failures = 0;
  private failureDeadline = 0;
  readonly instance_id: string;
  readonly owner_id: string;
  constructor(private readonly sql: Database.Database, private readonly monotonic = () => performance.now(),
    private readonly wall = () => new Date()) {
    sql.exec(`CREATE TABLE IF NOT EXISTS dashboard_operator_identity (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL, owner_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS dashboard_operator_devices (
      device_id TEXT PRIMARY KEY, capabilities_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
      active INTEGER NOT NULL CHECK(active IN (0,1)), created_at TEXT NOT NULL
    ) STRICT;`);
    sql.prepare("INSERT OR IGNORE INTO dashboard_operator_identity VALUES(1,?,?)").run(opaque("instance_"), opaque("operator_"));
    const identity = sql.prepare("SELECT instance_id,owner_id FROM dashboard_operator_identity WHERE singleton=1").get() as {
      instance_id: string; owner_id: string;
    };
    this.instance_id = identity.instance_id; this.owner_id = identity.owner_id;
  }

  issueCode(input: unknown): { code: string; capabilities: OperatorCapability[]; expires_at: string } {
    const parsed = capabilitiesSchema.safeParse(input);
    if (!parsed.success) throw new OperatorAuthError("invalid");
    const code = randomBytes(18).toString("base64url");
    const capabilities = [...parsed.data].sort();
    this.pairing = { digest: hash(code), capabilities, deadline: this.monotonic() + 300_000 };
    return { code, capabilities, expires_at: new Date(this.wall().getTime() + 300_000).toISOString() };
  }

  pair(code: unknown): { token: string; session: OperatorSession } {
    this.prune();
    const now = this.monotonic();
    if (now >= this.failureDeadline) { this.failures = 0; this.failureDeadline = now + 60_000; }
    if (this.failures >= 8) throw new OperatorAuthError("limit");
    const pairing = this.pairing;
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(code) || !pairing
      || pairing.deadline <= now || hash(code) !== pairing.digest) {
      this.failures++; throw new OperatorAuthError("denied");
    }
    const token = randomBytes(32).toString("base64url"), device_id = opaque("device_");
    this.sql.transaction(() => {
      const count = this.sql.prepare("SELECT count(*) AS n FROM dashboard_operator_devices WHERE active=1").get() as { n: number };
      if (count.n >= 32 || this.sessions.size >= 32) throw new OperatorAuthError("limit");
      this.sql.prepare("INSERT INTO dashboard_operator_devices VALUES(?,?,1,1,?)")
        .run(device_id, JSON.stringify(pairing.capabilities), this.wall().toISOString());
    }).immediate();
    this.pairing = undefined;
    this.sessions.set(hash(token), { device_id, revision: 1, csrf: randomBytes(32).toString("base64url"),
      deadline: now + 43_200_000, enrollmentDeadline: now + 300_000, expires_at: new Date(this.wall().getTime() + 43_200_000).toISOString() });
    return { token, session: this.session(token)! };
  }

  session(token: unknown): OperatorSession | null {
    this.prune();
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = this.sessions.get(hash(token));
    if (!session) return null;
    const row = this.sql.prepare("SELECT * FROM dashboard_operator_devices WHERE device_id=?").get(session.device_id) as DeviceRow | undefined;
    if (!row || row.active !== 1 || row.revision !== session.revision) { this.sessions.delete(hash(token)); return null; }
    let capabilities: OperatorCapability[];
    try { capabilities = capabilitiesSchema.parse(JSON.parse(row.capabilities_json)); } catch { return null; }
    return { instance_id: this.instance_id, owner_id: this.owner_id, device_id: row.device_id,
      grant_revision: row.revision, capabilities, csrf: session.csrf, expires_at: session.expires_at };
  }

  /** All writes use this same Dispatcher connection; permission and Task receipt
   * validation occur in one immediate transaction, without asynchronous gaps. */
  withSession<T>(token: string, capability: OperatorCapability, execute: (authority: OperatorAuthority) => T): T {
    if (execute.constructor.name === "AsyncFunction") throw new OperatorAuthError("invalid");
    return this.sql.transaction(() => {
      const session = this.session(token);
      if (!session?.capabilities.includes(capability)) throw new OperatorAuthError("denied");
      const result = execute({ instance_id: session.instance_id, owner_id: session.owner_id,
        device_id: session.device_id, grant_revision: session.grant_revision });
      if (result && typeof (result as { then?: unknown }).then === "function") throw new OperatorAuthError("invalid");
      return result;
    }).immediate();
  }

  logout(token: string): void { this.sessions.delete(hash(token)); }
  canEnroll(token: string): boolean {
    const session=this.session(token), internal=this.sessions.get(hash(token));
    return !!session && !!internal && internal.enrollmentDeadline>this.monotonic()
      && session.capabilities.some(value=>value==="approvals:native"||value==="approvals:external");
  }
  authorize(authority:OperatorAuthority):boolean {
    const row=this.sql.prepare("SELECT active,revision FROM dashboard_operator_devices WHERE device_id=?").get(authority.device_id) as {active:number;revision:number}|undefined;
    return authority.instance_id===this.instance_id&&authority.owner_id===this.owner_id&&row?.active===1&&row.revision===authority.grant_revision;
  }
  resetSessions(): void { this.sessions.clear(); this.pairing = undefined; }
  revoke(deviceId?: string): void {
    if (deviceId !== undefined && !/^device_[a-f0-9]{32}$/.test(deviceId)) throw new OperatorAuthError("invalid");
    this.sql.transaction(() => {
      if (deviceId === undefined) this.sql.prepare("UPDATE dashboard_operator_devices SET active=0,revision=revision+1 WHERE active=1").run();
      else this.sql.prepare("UPDATE dashboard_operator_devices SET active=0,revision=revision+1 WHERE device_id=? AND active=1").run(deviceId);
    }).immediate();
    for (const [key, session] of this.sessions) if (deviceId === undefined || session.device_id === deviceId) this.sessions.delete(key);
    // Any host revocation also invalidates an outstanding bootstrap code.
    this.pairing = undefined;
  }
  status(): { devices: {device_id: string; capabilities: OperatorCapability[]; revision: number}[]; sessions: number } {
    this.prune();
    const rows = this.sql.prepare("SELECT * FROM dashboard_operator_devices WHERE active=1 ORDER BY created_at,device_id LIMIT 33").all() as DeviceRow[];
    if (rows.length > 32) throw new OperatorAuthError("limit");
    return { devices: rows.map(row => ({ device_id: row.device_id, capabilities: capabilitiesSchema.parse(JSON.parse(row.capabilities_json)),
      revision: row.revision })), sessions: this.sessions.size };
  }
  private prune(): void {
    const now = this.monotonic();
    for (const [key, session] of this.sessions) if (session.deadline <= now) this.sessions.delete(key);
    if (this.pairing && this.pairing.deadline <= now) this.pairing = undefined;
  }
}
