import type {AgentRecord} from "./store.js";

export interface ConversationIdentity {
  name:string;generation:string;role:"main"|"worker";thread_id:string|null;attempt_id:string|null;
  archived?:boolean;
  state:AgentRecord["state"];connected:boolean;observed_at:string;
}
export interface ConversationFile {path:string;change:"add"|"delete"|"update";move_path?:string;additions?:number;deletions?:number;diff?:string}
export interface ConversationItem {turn_started_at?:string;turn_completed_at?:string;id:string;turn_id:string;kind:"user_message"|"assistant_message"|"tool_progress";text?:string;status?:string;tool_type?:string;tool_name?:string;command?:string;input?:string;output?:string;error?:string;files?:ConversationFile[];duration_ms?:number;exit_code?:number;truncated?:boolean}
export interface ObservationEvent {occurred_at?:string;sequence:number;kind:string;turn_id?:string;item_id?:string;text?:string;observed_at:string}
export interface ConversationSnapshot extends ConversationIdentity {
  items:ConversationItem[];events:ObservationEvent[];cursor:number;oldest_sequence:number;gap:boolean;truncated:boolean;
}
/** App Serverの秒/ms値をUTCへ正規化する。未知値は日時として公開しない。 */
function timestamp(value:unknown,scale=1):string|undefined {
  if(typeof value!=="number"||!Number.isFinite(value)||value<0)return;
  const ms=value*scale;if(!Number.isSafeInteger(ms)||ms>253402300799999)return;
  return new Date(ms).toISOString();
}
export function validObservationTimestamp(value:unknown):value is string {
  return typeof value==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
}
export const record=(x:unknown):Record<string,unknown>=>x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:{};
const identifier=(x:unknown):string|undefined=>typeof x==="string"&&/^[a-zA-Z0-9_-]{1,160}$/.test(x)?x:undefined;
/** 端末認証を閲覧境界とする。互換用の関数名だが本文を加工・省略しない。 */
export function sanitizeObservationText(value:string,_limit?:number):string {return value;}
/** projected DTOを再検証する公開境界。未知fieldやraw payloadを通さない。 */
export function sanitizeConversationItem(value:unknown):ConversationItem|undefined {
  const v=record(value),id=identifier(v.id),turn=identifier(v.turn_id);if(!id||!turn||!["user_message","assistant_message","tool_progress"].includes(String(v.kind)))return;
  const out:ConversationItem={id,turn_id:turn,kind:v.kind as ConversationItem["kind"]};
  for(const field of ["turn_started_at","turn_completed_at"] as const)if(validObservationTimestamp(v[field]))out[field]=v[field];
  const metadataOnly=["imageGeneration","sleep","contextCompaction","enteredReviewMode","exitedReviewMode","subAgentActivity","functionCallOutput"].includes(String(v.tool_type));
  for(const field of ["text","tool_name","command","input","output","error"] as const)if((field==="text"?out.kind!=="tool_progress":out.kind==="tool_progress")&&(!metadataOnly||(["tool_name","output"].includes(field)&&v.tool_type==="functionCallOutput"))&&typeof v[field]==="string"){
    out[field]=v[field];
  }
  if(out.kind==="tool_progress"&&(!metadataOnly||v.tool_type==="imageGeneration")&&["inProgress","completed","failed","declined","interrupted"].includes(String(v.status)))out.status=String(v.status);
  if(out.kind==="tool_progress"&&["commandExecution","fileChange","mcpToolCall","dynamicToolCall","collabAgentToolCall","webSearch","imageView","imageGeneration","sleep","contextCompaction","enteredReviewMode","exitedReviewMode","subAgentActivity","functionCallOutput"].includes(String(v.tool_type)))out.tool_type=String(v.tool_type);
  if(out.kind==="tool_progress"&&(!metadataOnly||v.tool_type==="sleep")&&Number.isFinite(v.duration_ms)&&Number(v.duration_ms)>=0)out.duration_ms=Number(v.duration_ms);
  if(out.kind==="tool_progress"&&!metadataOnly&&Number.isSafeInteger(v.exit_code))out.exit_code=Number(v.exit_code);
  if(out.kind==="tool_progress"&&!metadataOnly&&Array.isArray(v.files)){out.files=[];for(const raw of v.files){const f=record(raw);if(typeof f.path!=="string"||!["add","delete","update"].includes(String(f.change)))continue;const file:ConversationFile={path:f.path,change:f.change as ConversationFile["change"]};if(file.change==="update"&&typeof f.move_path==="string"){file.move_path=f.move_path;}for(const k of ["additions","deletions"] as const)if(Number.isSafeInteger(f[k])&&Number(f[k])>=0)file[k]=Number(f[k]);if(out.tool_type==="fileChange"&&typeof f.diff==="string")file.diff=f.diff;out.files.push(file);}}
  if(v.truncated===true)out.truncated=true;return out;
}
/** Codex 0.160.0 generate-ts v2/ThreadItemの既知fieldだけを採用する。テキスト内容のredactionは行わない。 */
export function projectItem(value:unknown,turnId:string):ConversationItem|undefined {
  const item=record(value),id=identifier(item.id);if(!id)return;
  const out:ConversationItem={id,turn_id:turnId,kind:"tool_progress"};
  if(item.type==="userMessage"){
    const chunks=Array.isArray(item.content)?item.content.filter(x=>record(x).type==="text").map(x=>record(x).text).filter((x):x is string=>typeof x==="string"):[];
    if(!chunks.length)return;out.kind="user_message";out.text=chunks.join("\n");
  }else if(item.type==="agentMessage"&&typeof item.text==="string"){out.kind="assistant_message";out.text=item.text;}
  else if(["commandExecution","fileChange","mcpToolCall","dynamicToolCall","collabAgentToolCall","webSearch","imageView","imageGeneration","sleep","contextCompaction","enteredReviewMode","exitedReviewMode","subAgentActivity","functionCallOutput"].includes(String(item.type))){
    out.tool_type=String(item.type);if(typeof item.status==="string"&&!["sleep","contextCompaction","enteredReviewMode","exitedReviewMode","subAgentActivity","functionCallOutput"].includes(String(item.type)))out.status=item.status;
    if(typeof item.durationMs==="number")out.duration_ms=item.durationMs;
    if(item.type==="imageGeneration"){
      // 固定CodexのImageGenerationBeginは空status。endのfailureはcompletedより優先する。
      if(item.failure!==null&&typeof item.failure==="object")out.status="failed";
      else if(item.status==="")out.status="inProgress";
    }
    if(item.type==="functionCallOutput"){
      if(typeof item.name==="string")out.tool_name=item.name;
      if(typeof item.output==="string")out.output=item.output;
      else if(Array.isArray(item.output)){

        const chunks:string[]=[];
        for(const raw of item.output){
          const part=record(raw);if(part.type!=="input_text"||typeof part.text!=="string")continue;
          chunks.push(part.text);
        }
        out.output=chunks.join("\n");
      }
    }
    if(item.type==="commandExecution"){if(typeof item.command==="string")out.command=item.command;if(typeof item.aggregatedOutput==="string")out.output=item.aggregatedOutput;if(typeof item.exitCode==="number")out.exit_code=item.exitCode;}
    if(item.type==="fileChange"&&Array.isArray(item.changes)){
      out.files=item.changes.flatMap(raw=>{
        const f=record(raw),kind=record(f.kind);if(typeof f.path!=="string"||!["add","delete","update"].includes(String(kind.type)))return [];
        const file:ConversationFile={path:f.path,change:kind.type as ConversationFile["change"]};if(kind.type==="update"&&typeof kind.move_path==="string")file.move_path=kind.move_path;
        if(typeof f.diff!=="string")return [file];
        file.diff=f.diff;
        // Codex FileChange Add/Deleteのdiffはraw content。Updateだけがunified diff。
        if(kind.type==="add"||kind.type==="delete"){
          const lines=f.diff.length===0?0:f.diff.split("\n").length-(f.diff.endsWith("\n")?1:0);
          return [{...file,additions:kind.type==="add"?lines:0,deletions:kind.type==="delete"?lines:0}];
        }
        let additions=0,deletions=0,inHunk=false;
        for(const line of f.diff.split("\n")){
          if(line.startsWith("diff --git ")){inHunk=false;continue;}
          if(line.startsWith("@@")){inHunk=true;continue;}
          if(!inHunk&&/^(?:---|\+\+\+) /.test(line))continue;
          if(line.startsWith("+"))additions++;else if(line.startsWith("-"))deletions++;
        }
        return [{...file,additions,deletions}];
      });
    }
    if(item.type==="collabAgentToolCall"){
      const tools=["spawnAgent","sendInput","resumeAgent","wait","closeAgent","sendMessage","followupTask","interruptAgent","listAgents"];
      if(tools.includes(String(item.tool)))out.tool_name=String(item.tool);
      if(typeof item.prompt==="string")out.input=item.prompt;
      const states=Object.values(record(item.agentsStates));
      const lines=states.map(raw=>{const state=record(raw);const status=["pendingInit","running","interrupted","completed","errored","shutdown","notFound"].includes(String(state.status))?String(state.status):"";const message=typeof state.message==="string"?state.message:"";return [status,message].filter(Boolean).join(": ");}).filter(Boolean);
      if(lines.length)out.output=lines.join("\n");
    }
    if(item.type==="mcpToolCall"||item.type==="dynamicToolCall"){
      out.tool_name=[item.server??item.namespace,item.tool].filter(x=>typeof x==="string").join(".");
      if(typeof item.arguments==="string")out.input=item.arguments;
      else if(item.arguments!==undefined)out.input=JSON.stringify(item.arguments);
      const content=item.type==="mcpToolCall"?record(item.result).content:item.contentItems;
      if(Array.isArray(content))out.output=content.filter(x=>["text","inputText"].includes(String(record(x).type))).map(x=>record(x).text).filter(x=>typeof x==="string").join("\n");
      if(record(item.result).structuredContent!==undefined)out.output=[out.output,JSON.stringify(record(item.result).structuredContent)].filter(x=>x!==undefined).join("\n");
      if(typeof record(item.error).message==="string")out.error=record(item.error).message as string;
    }
    if(item.type==="webSearch"&&typeof item.query==="string")out.input=item.query;
  }else return;
  return sanitizeConversationItem(out);
}
export function projectHistory(value:unknown):{threadId:string|undefined;items:ConversationItem[];truncated:boolean} {
  const thread=record(record(value).thread),turns=Array.isArray(thread.turns)?thread.turns:[],items:ConversationItem[]=[];
  let truncated=turns.length>100,inspected=0;
  // 最新から採用し上限でprojection自体を止める。古い重いtool payloadを先に処理しない。
  outer:for(let ti=turns.length-1;ti>=Math.max(0,turns.length-100);ti--){
    if(items.length>=200||inspected>=1000){truncated=true;break;}
    const turn=record(turns[ti]),id=identifier(turn.id);if(!id)continue;
    const source=Array.isArray(turn.items)?turn.items:[];if(source.length>200)truncated=true;
    for(let ii=source.length-1;ii>=Math.max(0,source.length-200);ii--){
      if(items.length>=200||inspected>=1000){truncated=true;break outer;}
      inspected++;const projected=projectItem(source[ii],id);if(!projected)continue;
      const start=timestamp(turn.startedAt,1000),end=timestamp(turn.completedAt,1000);
      if(start)projected.turn_started_at=start;if(end)projected.turn_completed_at=end;
      items.push(projected);if(projected.truncated)truncated=true;
    }
  }
  return {threadId:typeof thread.id==="string"?thread.id:undefined,items:items.reverse(),truncated};
}
export function projectNotification(method:string|undefined,value:unknown):Omit<ObservationEvent,"sequence"|"observed_at">|undefined {
  const p=record(value),turn=record(p.turn),turnId=identifier(p.turnId)??identifier(turn.id),itemId=identifier(p.itemId)??identifier(record(p.item).id);
  const occurred=method==="item/started"?timestamp(p.startedAtMs):method==="item/completed"?timestamp(p.completedAtMs):method==="turn/started"?timestamp(turn.startedAt,1000):method==="turn/completed"?timestamp(turn.completedAt,1000):undefined;
  if(["turn/started","turn/completed","item/started","item/completed","serverRequest/resolved"].includes(method??""))return {kind:method!,...(occurred?{occurred_at:occurred}:{}),...(turnId?{turn_id:turnId}:{}),...(itemId?{item_id:itemId}:{})};
  // 本文は完成済みitem/historyから取得し、delta通知は更新契機だけに使う。
  if(method==="item/agentMessage/delta"&&turnId&&itemId)return {kind:method,turn_id:turnId,item_id:itemId};
}
