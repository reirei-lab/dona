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
  snapshot: Omit<DashboardTaskSnapshot,"runtime_binding">;
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
        if(!before.runtime_binding) return {snapshot:publicSnapshot(before),runtime:{status:"not_started"}};
        const binding=before.runtime_binding;
        const expectedAgent = before.attempts.find(row => row.attempt_id === before.task.current_attempt_id)?.agent_name;
        if (!expectedAgent) throw Error("observation_attempt_missing");
        const started = performance.now();
        let cursor: string | undefined;
        const seen = new Set<string>();
        // Bounded runtime inventory: do not scan personal Codex sessions.
        for (let page = 0; page < 100; page++) {
          const result = await withinDeadline(this.runtime.conversations(cursor), started);
          const currentAuthority = authorize();
          if (!currentAuthority || currentAuthority.revision !== authority.revision || !currentAuthority.task(id) || !currentAuthority.conversation(id)) return null;
          if (performance.now() - started > 5000 || result.items.length > 100) throw Error("observation_inventory_limit");
          const matches = result.items.filter(row => row.role === "worker" && row.attempt_id === before.task.current_attempt_id);
          if (matches.length > 1) throw Error("observation_identity_ambiguous");
          const match = matches[0];
          if (match && (match.name !== expectedAgent || match.name!==binding.agent_name || match.generation!==binding.generation || match.thread_id!==binding.thread_id)) throw Error("observation_identity_changed");
          if (match) {
            const content = await withinDeadline(this.runtime.conversation(match.name,match.generation,afterSequence), started);
            if (performance.now() - started > 5000 || content.name !== match.name || content.generation !== match.generation || content.role !== "worker"
              || content.thread_id !== match.thread_id || content.attempt_id !== before.task.current_attempt_id) throw Error("observation_identity_changed");
            observed = {status: "observed", conversation: publicConversation(content)}; break;
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
    if (after.fingerprint !== before.fingerprint) return {snapshot: publicSnapshot(after), runtime: {status: "unavailable"}};
    if (!current.conversation(id)) observed = {status: "forbidden"};
    return {snapshot: publicSnapshot(after), runtime: observed};
  }
}

async function withinDeadline<T>(operation: Promise<T>, started: number): Promise<T> {
  const remaining = 5000 - (performance.now() - started);
  if (remaining <= 0) throw Error("observation_deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("observation_deadline")), remaining);
    })]);
  } finally { clearTimeout(timer); }
}

/** Keep the network boundary allowlisted even when a future runtime adds fields. */
function publicConversation(value: ConversationContent): ConversationContent {
  if (!Array.isArray(value.items) || value.items.length > 200 || !Array.isArray(value.events) || value.events.length > 1000
    || !Number.isSafeInteger(value.cursor) || value.cursor < 0 || !Number.isSafeInteger(value.oldest_sequence) || value.oldest_sequence < 0
    || typeof value.connected !== "boolean" || typeof value.gap !== "boolean" || typeof value.truncated !== "boolean"
    || !Number.isFinite(Date.parse(value.observed_at))) throw Error("observation_projection_invalid");
  const id = (text: string) => {if(typeof text!=="string"||!/^[A-Za-z0-9_-]{1,160}$/.test(text))throw Error("observation_projection_invalid");return text;};
  const text = (input: string) => {if(typeof input!=="string")throw Error("observation_projection_invalid");return input.slice(0,8192);};
  const items = value.items.map(item => {
    if(!["assistant_message","tool_progress"].includes(item.kind))throw Error("observation_projection_invalid");
    return {id:id(item.id),turn_id:id(item.turn_id),kind:item.kind,
      ...(item.kind==="assistant_message"&&item.text!==undefined?{text:text(item.text)}:{}),
      ...(item.kind==="tool_progress"&&["inProgress","completed","failed","declined"].includes(item.status??"")?{status:item.status!}:{})};
  });
  const kinds=new Set(["turn/started","turn/completed","item/started","item/completed","serverRequest/resolved","item/agentMessage/delta"]);
  const events=value.events.filter(event=>kinds.has(event.kind)).map(event=>{
    if(!Number.isSafeInteger(event.sequence)||event.sequence<0||!Number.isFinite(Date.parse(event.observed_at)))throw Error("observation_projection_invalid");
    return {sequence:event.sequence,kind:event.kind,observed_at:event.observed_at,
      ...(event.turn_id===undefined?{}:{turn_id:id(event.turn_id)}),...(event.item_id===undefined?{}:{item_id:id(event.item_id)}),
      ...(event.kind==="item/agentMessage/delta"&&event.text!==undefined?{text:text(event.text)}:{})};
  });
  const result={name:id(value.name),generation:id(value.generation),role:value.role,thread_id:value.thread_id===null?null:id(value.thread_id),
    attempt_id:value.attempt_id===null?null:id(value.attempt_id),connected:value.connected,observed_at:value.observed_at,state:id(value.state),
    items,events,cursor:value.cursor,oldest_sequence:value.oldest_sequence,gap:value.gap,truncated:value.truncated};
  if(Buffer.byteLength(JSON.stringify(result))>1_048_576)throw Error("observation_projection_limit");
  return result;
}

function publicSnapshot(value:DashboardTaskSnapshot):Omit<DashboardTaskSnapshot,"runtime_binding"> {
  return {task:value.task,attempts:value.attempts,fingerprint:value.fingerprint};
}
