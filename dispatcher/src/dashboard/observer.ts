import { DashboardTaskReader, type DashboardTaskSnapshot } from "./task-reader.js";

export interface ObservedConversation {
  name: string; generation: string; role: "main" | "worker";
  thread_id: string | null; attempt_id: string | null; connected: boolean;
  observed_at: string; state: string;
}
export interface ConversationContent extends ObservedConversation {
  items: readonly {id: string; turn_id: string; kind: "assistant_message" | "tool_progress"; text?: string; status?: string}[];
  events: readonly {sequence: number; kind: string; turn_id?: string; item_id?: string; text?: string; observed_at: string}[]; cursor: number; oldest_sequence: number; gap: boolean; truncated: boolean;
}
export interface ObservationRuntime {
  conversations(after?: string): Promise<{items: ObservedConversation[]; next: string | null}>;
  conversation(name: string, generation: string, afterSequence?: number): Promise<ConversationContent>;
}
export interface DashboardAuthority {
  /** Changes on logout/revocation, not on harmless poll requests. */
  revision: string;
  task(id: string): boolean;
  conversation(id: string): boolean;
}
export interface ObservedTask {
  snapshot: DashboardTaskSnapshot;
  runtime: {status: "observed"; conversation: ConversationContent} | {status: "unavailable" | "not_started" | "forbidden"};
}
/** The authority callback is evaluated again after runtime I/O. A revoked
 * browser or superseded Attempt cannot receive an earlier private response. */
export class DashboardObserver {
  constructor(private readonly tasks: DashboardTaskReader, private readonly runtime: ObservationRuntime) {}
  async detail(id: string, authorize: () => DashboardAuthority | null, afterSequence?: number): Promise<ObservedTask | null> {
    const authority = authorize();
    if (!authority?.task(id)) return null;
    const before = this.tasks.snapshot(id);
    if (!before) return null;
    let observed: ObservedTask["runtime"] = {status: "forbidden"};
    if (authority.conversation(id)) {
      observed = {status: "not_started"};
      try {
        const expectedAgent = before.attempts.find(row => row.attempt_id === before.task.current_attempt_id)?.agent_name;
        if (!expectedAgent) throw Error("observation_attempt_missing");
        const started = performance.now();
        let cursor: string | undefined;
        const seen = new Set<string>();
        // Bounded runtime inventory: do not scan personal Codex sessions.
        for (let page = 0; page < 100; page++) {
          const result = await this.runtime.conversations(cursor);
          const currentAuthority = authorize();
          if (!currentAuthority || currentAuthority.revision !== authority.revision || !currentAuthority.task(id) || !currentAuthority.conversation(id)) return null;
          if (performance.now() - started > 5000 || result.items.length > 100) throw Error("observation_inventory_limit");
          const matches = result.items.filter(row => row.role === "worker" && row.attempt_id === before.task.current_attempt_id);
          if (matches.length > 1) throw Error("observation_identity_ambiguous");
          const match = matches[0];
          if (match && match.name !== expectedAgent) throw Error("observation_identity_changed");
          if (match) {
            const content = await this.runtime.conversation(match.name,match.generation,afterSequence);
            if (performance.now() - started > 5000 || content.name !== match.name || content.generation !== match.generation || content.role !== "worker"
              || content.thread_id !== match.thread_id || content.attempt_id !== before.task.current_attempt_id) throw Error("observation_identity_changed");
            observed = {status: "observed", conversation: content}; break;
          }
          if (result.next === null) break;
          if (seen.has(result.next) || page === 99) throw Error("observation_inventory_incomplete");
          seen.add(result.next); cursor = result.next;
        }
      } catch { observed = {status: "unavailable"}; }
    }
    const current = authorize();
    if (!current || current.revision !== authority.revision || !current.task(id)) return null;
    const after = this.tasks.snapshot(id);
    if (!after) return null;
    if (after.fingerprint !== before.fingerprint) return {snapshot: after, runtime: {status: "unavailable"}};
    if (!current.conversation(id)) observed = {status: "forbidden"};
    return {snapshot: after, runtime: observed};
  }
}
