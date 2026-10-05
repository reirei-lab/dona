import { sanitizeConversationItem, type ConversationItem } from "../app-server/observation.js";
import { DashboardTaskReader, type DashboardTaskSnapshot } from "./task-reader.js";

export interface ObservedConversation {
  name: string; generation: string; role: "main" | "worker";
  thread_id: string | null; attempt_id: string | null; connected: boolean;
  observed_at: string; state: string;
}
export interface ConversationContent extends ObservedConversation {
  items: readonly ConversationItem[];
  events: readonly {sequence: number; kind: string; turn_id?: string; item_id?: string; text?: string; observed_at: string}[]; cursor: number; oldest_sequence: number; gap: boolean; truncated: boolean;
}
export interface ObservationRuntime {
  conversations(after?: string): Promise<{items: ObservedConversation[]; next: string | null}>;
  conversationHistory?(name: string, afterGeneration?: string): Promise<{items: {name:string;generation:string;role:"main"|"worker";thread_id:string|null;attempt_id:string|null;recorded_at:string}[];next:string|null}>;
  conversation(name: string, generation: string, afterSequence?: number): Promise<ConversationContent>;
}
export interface DashboardAuthority {
  /** Changes on logout/revocation, not on harmless poll requests. */
  revision: string;
  task(id: string): boolean;
  conversation(id: string): boolean;
  mainConversation?(): boolean;
}
export interface ObservedTask {
  snapshot: Pick<DashboardTaskSnapshot,"task"|"attempts"|"fingerprint"|"selected_attempt_id"|"result"|"request">;
  runtime: {status: "observed"; conversation: ConversationContent} | {status: "unavailable" | "not_started" | "forbidden"};
}
/** The authority callback is evaluated again after runtime I/O. A revoked
 * browser or superseded Attempt cannot receive an earlier private response. */
export class DashboardObserver {
  constructor(private readonly tasks: DashboardTaskReader, private readonly runtime: ObservationRuntime) {}
  async detail(id: string, authorize: () => DashboardAuthority | null, afterSequence?: number, attemptId?: string): Promise<ObservedTask | null> {
    const authority = authorize();
    if (!authority?.task(id)) return null;
    const before = this.tasks.snapshot(id, attemptId);
    if (!before) return null;
    let observed: ObservedTask["runtime"] = {status: "forbidden"};
    if (authority.conversation(id)) {
      observed = {status: "unavailable"};
      try {
        if(!before.runtime_binding) return {snapshot:publicSnapshot(before),runtime:{status:before.runtime_binding_state==="missing"&&before.attempts.find(row=>row.attempt_id===before.selected_attempt_id)?.status==="queued"?"not_started":"unavailable"}};
        const binding=before.runtime_binding;
        const expectedAgent = before.attempts.find(row => row.attempt_id === before.selected_attempt_id)?.agent_name;
        if (!expectedAgent) throw Error("observation_attempt_missing");
        const started = performance.now();
        // Exact durable binding authorizes cached history even after inventory
        // cleanup. Runtime still checks the generation and never resumes it.
        const content = await withinDeadline(this.runtime.conversation(expectedAgent,binding.generation,afterSequence),started);
        if(content.name!==binding.agent_name||content.generation!==binding.generation||content.thread_id!==binding.thread_id||content.role!=="worker"||content.attempt_id!==before.selected_attempt_id)throw Error("observation_identity_changed");
        observed={status:"observed",conversation:publicConversation(content)};
      } catch { observed = {status: "unavailable"}; }
    }
    const current = authorize();
    if (!current || current.revision !== authority.revision || !current.task(id)) return null;
    const after = this.tasks.snapshot(id, attemptId);
    if (!after) return null;
    if (after.fingerprint !== before.fingerprint || after.request !== before.request) return {snapshot: publicSnapshot(after, current.conversation(id)), runtime: {status: "unavailable"}};
    if (!current.conversation(id)) observed = {status: "forbidden"};
    return {snapshot: publicSnapshot(after, current.conversation(id)), runtime: observed};
  }
  async mainList(authorize:()=>DashboardAuthority|null):Promise<{items:ObservedConversation[];next:null}|null> {
    return this.mainListWithinDeadline(authorize,performance.now());
  }
  private async mainListWithinDeadline(authorize:()=>DashboardAuthority|null,started:number):Promise<{items:ObservedConversation[];next:null}|null> {
    const authority=authorize(); if(!authority?.mainConversation?.())return null;
    const items:ObservedConversation[]=[];let cursor:string|undefined;const seen=new Set<string>();
    for(let page=0;page<100;page++) {
      const result=await withinDeadline(this.runtime.conversations(cursor),started);
      if(!sameMainAuthority(authorize(),authority))return null;
      if(result.items.length>100)throw Error("observation_inventory_limit");
      for(const row of result.items)if(row.role==="main"&&row.attempt_id===null) {
        items.push(mainMetadata(row));
        if(this.runtime.conversationHistory) {
          let after:string|undefined;const historyCursors=new Set<string>();
          for(let n=0;n<10;n++) {
            const history=await withinDeadline(this.runtime.conversationHistory(row.name,after),started);
            if(!sameMainAuthority(authorize(),authority))return null;
            if(history.items.length>100)throw Error("observation_inventory_limit");
            for(const old of history.items)if(old.name===row.name&&old.role==="main"&&old.attempt_id===null&&old.generation!==row.generation)
              items.push(mainMetadata({...old,connected:false,observed_at:old.recorded_at,state:"unknown"}));
            if(history.next===null)break;
            if(historyCursors.has(history.next)||n===9)throw Error("observation_inventory_incomplete");
            historyCursors.add(history.next);after=history.next;
          }
        }
      }
      if(items.length>1000)throw Error("observation_inventory_limit");
      if(result.next===null)break;
      if(seen.has(result.next)||page===99)throw Error("observation_inventory_incomplete");seen.add(result.next);cursor=result.next;
    }
    if(!sameMainAuthority(authorize(),authority))return null;
    const identities=new Set<string>();
    for(const row of items){const key=JSON.stringify([row.name,row.generation]);if(identities.has(key))throw Error("observation_identity_ambiguous");identities.add(key);}
    return {items,next:null};
  }
  async mainDetail(name:string,generation:string,authorize:()=>DashboardAuthority|null,afterSequence?:number):Promise<ObservedTask["runtime"]|null> {
    const started=performance.now(),authority=authorize();if(!authority?.mainConversation?.())return null;
    try {
      const inventory=await this.mainListWithinDeadline(authorize,started);
      if(!inventory||!sameMainAuthority(authorize(),authority))return null;
      const match=inventory.items.find(row=>row.name===name&&row.generation===generation);
      if(!match)return {status:"unavailable"};
      const content=await withinDeadline(this.runtime.conversation(name,generation,afterSequence),started);
      if(!sameMainAuthority(authorize(),authority))return null;
      if(content.name!==name||content.generation!==generation||content.role!=="main"||content.attempt_id!==null||content.thread_id!==match.thread_id)throw Error("observation_identity_changed");
      return {status:"observed",conversation:publicConversation(content)};
    }catch {return sameMainAuthority(authorize(),authority)?{status:"unavailable"}:null;}
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
  const items = value.items.map(item => {
    const projected=sanitizeConversationItem(item);
    if(!projected)throw Error("observation_projection_invalid");
    return projected;
  });
  const kinds=new Set(["turn/started","turn/completed","item/started","item/completed","serverRequest/resolved","item/agentMessage/delta"]);
  const events=value.events.filter(event=>kinds.has(event.kind)).map(event=>{
    if(!Number.isSafeInteger(event.sequence)||event.sequence<0||!Number.isFinite(Date.parse(event.observed_at)))throw Error("observation_projection_invalid");
    return {sequence:event.sequence,kind:event.kind,observed_at:event.observed_at,
      ...(event.turn_id===undefined?{}:{turn_id:id(event.turn_id)}),...(event.item_id===undefined?{}:{item_id:id(event.item_id)})};
  });
  const result={name:id(value.name),generation:id(value.generation),role:value.role,thread_id:value.thread_id===null?null:id(value.thread_id),
    attempt_id:value.attempt_id===null?null:id(value.attempt_id),connected:value.connected,observed_at:value.observed_at,state:id(value.state),
    items,events,cursor:value.cursor,oldest_sequence:value.oldest_sequence,gap:value.gap,truncated:value.truncated};
  if(Buffer.byteLength(JSON.stringify(result))>1_048_576)throw Error("observation_projection_limit");
  return result;
}

function publicSnapshot(value:DashboardTaskSnapshot, includeResult=true):Pick<DashboardTaskSnapshot,"task"|"attempts"|"fingerprint"|"selected_attempt_id"|"result"|"request"> {
  return {task:value.task,attempts:value.attempts,fingerprint:value.fingerprint,selected_attempt_id:value.selected_attempt_id,result:includeResult?value.result:null,...(includeResult&&value.request!==undefined?{request:value.request}:{})};
}

function sameMainAuthority(current:DashboardAuthority|null,before:DashboardAuthority):boolean {
  return !!current&&current.revision===before.revision&&current.mainConversation?.()===true;
}
function mainMetadata(row:ObservedConversation):ObservedConversation {
  const projected=publicConversation({...row,items:[],events:[],cursor:0,oldest_sequence:0,gap:false,truncated:false});
  return {name:projected.name,generation:projected.generation,role:projected.role,thread_id:projected.thread_id,attempt_id:projected.attempt_id,connected:projected.connected,observed_at:projected.observed_at,state:projected.state};
}
