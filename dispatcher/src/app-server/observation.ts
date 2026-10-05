import type {AgentRecord} from "./store.js";

export interface ConversationIdentity {
  name:string;generation:string;role:"main"|"worker";thread_id:string|null;attempt_id:string|null;
  archived?:boolean;
  state:AgentRecord["state"];connected:boolean;observed_at:string;
}
export interface ConversationFile {path:string;change:"add"|"delete"|"update";additions?:number;deletions?:number}
export interface ConversationItem {id:string;turn_id:string;kind:"user_message"|"assistant_message"|"tool_progress";text?:string;status?:string;tool_type?:string;tool_name?:string;command?:string;input?:string;output?:string;error?:string;files?:ConversationFile[];duration_ms?:number;exit_code?:number;truncated?:boolean}
export interface ObservationEvent {sequence:number;kind:string;turn_id?:string;item_id?:string;text?:string;observed_at:string}
export interface ConversationSnapshot extends ConversationIdentity {
  items:ConversationItem[];events:ObservationEvent[];cursor:number;oldest_sequence:number;gap:boolean;truncated:boolean;
}
export const record=(x:unknown):Record<string,unknown>=>x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:{};
const identifier=(x:unknown):string|undefined=>typeof x==="string"&&/^[a-zA-Z0-9_-]{1,160}$/.test(x)?x:undefined;
/** 識別子全体を採り、provider prefix/version suffixを含む既知credential名を共通判定する。 */
function credentialFields(text:string):RegExpMatchArray[] {
  return [...text.matchAll(/\b([A-Za-z_][A-Za-z0-9_-]*(?:[ ]+key)?)\b["']?\s*[:=]/gi)]
    .filter(match=>/(?:token|password|secret|apikey|authorization|cookie|credential|accesskey|privatekey)/i.test(match[1]!.replace(/[_ -]/g,"")));
}
function unescapeObservationText(value:string):string {
  return value.replace(/\\+u([0-9a-f]{4})/gi,(_,h:string)=>String.fromCharCode(parseInt(h,16))).replace(/\\\//g,"/").replace(/\\+(["'])/g,"$1");
}
function decodedObservationText(value:string,inspect?:(stage:string)=>void):string {
  let text=value;
  // 検査専用の保守的正規化。多重JSONのbackslash runをUnicode文字の前に残さない。
  for(let i=0;i<8;i++){
    const previous=text;inspect?.(text);
    // JSONを先に剥がしてURI authorityを検査し、percent decodeで区切りが変わる前も観測する。
    text=unescapeObservationText(text);inspect?.(text);
    try{text=decodeURIComponent(text);}catch{text=text.replace(/%([0-9a-f]{2})/gi,(_,h:string)=>String.fromCharCode(parseInt(h,16)));}
    inspect?.(text);if(text===previous)break;
  }
  return text;
}
/** 表示専用。既知credential/control pathを削除する。未知の秘密を完全検出する保証ではない。 */
export function sanitizeObservationText(value:string,limit=8192):string {
  if(value.length>131072)return "[上限を超える内容を省略]";
  let text=value.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|$))/g,"").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,"");
  const decodedText=decodedObservationText(text);
  if(/\\+(?:u[0-9a-f]{4}|["'/])|%[0-9a-f]{2}/i.test(decodedText))return "[多重encodeされた内容を省略]";
  // YAML tag/anchor/commentや複数行scalarも含め、既知credential assignmentがあるfield全体を省略する。
  if(credentialFields(decodedText).length>0)return "[機密情報を含む内容を省略]";
  if(/-----BEGIN [^-]*PRIVATE KEY|DONA_(?:JOB|EVENT)_(?:BEGIN|END)/i.test(decodedText))return "[保護された内容を省略]";
  text=text.split("\n").map(line=>{
    let credentialUri=false;
    const decoded=decodedObservationText(line,stage=>{if(/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/]+@/i.test(stage))credentialUri=true;});
    if(credentialUri)return "[機密情報を含む行を省略]";
    if(decoded!==line&&/(?:^|[\s"']|\/)(?:\.dona|\.codex|\.ssh|\.aws|\.config|Library\/Keychains|\.env(?:\.[\w-]+)?|auth\.json|credentials(?:\.json)?)(?:\/|$|[\s"'])/i.test(decoded))return "[保護されたパスを含む行を省略]";
    if(/(?:xox[a-z]-|xapp-|gh[pousr]_|github_pat_|sk-(?:proj-)?[A-Za-z0-9_-]{8}|\b(?:AKIA|ASIA)[A-Z0-9]{16}|--(?:token|password|secret|api-key|header)\s+\S+|\b(?:Bearer|Basic)\s+\S+|(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/]+@|(?:files|hooks)\.slack\.com|[?&](?:signature|sig|token|key|x-amz-[\w-]+)=|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i.test(decoded))return "[機密情報を含む行を省略]";
    return line.replace(/(?:~|\/[^\s"'<>]*)\/(?:\.dona|\.codex|\.ssh|\.aws|\.config|Library\/Keychains)(?:\/[^\s"'<>]*)?/g,"[保護されたパス]").replace(/(^|[\s"'<>])(?:[^\s"'<>]*\/)?(?:\.env(?:\.[\w-]+)?|auth\.json|credentials(?:\.json)?)(?=\s|$|["'<>])/g,"$1[保護されたパス]").replace(/\/(?:Users|home)\/[^/\s]+/g,"~");
  }).join("\n");
  return text.slice(0,limit);
}
/** projected DTOを再検証する公開境界。未知fieldやraw payloadを通さない。 */
export function sanitizeConversationItem(value:unknown):ConversationItem|undefined {
  const v=record(value),id=identifier(v.id),turn=identifier(v.turn_id);if(!id||!turn||!["user_message","assistant_message","tool_progress"].includes(String(v.kind)))return;
  const out:ConversationItem={id,turn_id:turn,kind:v.kind as ConversationItem["kind"]};
  for(const field of ["text","tool_name","command","input","output","error"] as const)if((field==="text"?out.kind!=="tool_progress":out.kind==="tool_progress")&&typeof v[field]==="string"){
    const limit=field==="tool_name"?200:field==="input"?4096:8192;out[field]=sanitizeObservationText(v[field],limit);if(v[field].length>limit)out.truncated=true;
  }
  if(out.kind==="tool_progress"&&["inProgress","completed","failed","declined","interrupted"].includes(String(v.status)))out.status=String(v.status);
  if(out.kind==="tool_progress"&&["commandExecution","fileChange","mcpToolCall","dynamicToolCall","collabAgentToolCall","webSearch","imageView"].includes(String(v.tool_type)))out.tool_type=String(v.tool_type);
  if(out.kind==="tool_progress"&&Number.isFinite(v.duration_ms)&&Number(v.duration_ms)>=0)out.duration_ms=Number(v.duration_ms);
  if(out.kind==="tool_progress"&&Number.isSafeInteger(v.exit_code))out.exit_code=Number(v.exit_code);
  if(out.kind==="tool_progress"&&Array.isArray(v.files)){out.files=[];if(v.files.length>20)out.truncated=true;for(const raw of v.files.slice(0,20)){const f=record(raw);if(typeof f.path!=="string"||!["add","delete","update"].includes(String(f.change)))continue;const file:ConversationFile={path:sanitizeObservationText(f.path,1024),change:f.change as ConversationFile["change"]};for(const k of ["additions","deletions"] as const)if(Number.isSafeInteger(f[k])&&Number(f[k])>=0)file[k]=Number(f[k]);out.files.push(file);}}
  if(v.truncated===true)out.truncated=true;return out;
}
function requestText(text:string):string|undefined {
  if(text.startsWith("[DONA_JOB_BEGIN]\njob_json:\n")){try{const end=text.indexOf("\n[DONA_JOB_END]");if(end<0)return;const job=record(JSON.parse(text.slice("[DONA_JOB_BEGIN]\njob_json:\n".length,end)));return typeof job.objective==="string"?job.objective:undefined;}catch{return;}}
  if(text.startsWith("[DONA_EVENT_BEGIN]\n")){try{const begin=text.indexOf("\nevent_json:\n"),end=text.indexOf("\n[DONA_EVENT_END]");if(begin<0||end<begin)return;const event=record(JSON.parse(text.slice(begin+"\nevent_json:\n".length,end))),payload=record(event.payload);return ["slack","web"].includes(String(event.source))&&typeof payload.text==="string"?payload.text:undefined;}catch{return;}}
  if(/DONA_(?:JOB|EVENT)|<system|<developer|<environment_context|<INSTRUCTIONS>/i.test(text))return;
  return text;
}
/** Codex 0.160.0 generate-ts v2/ThreadItemの既知fieldだけを採用する。reasoning/args全体は非公開。 */
export function projectItem(value:unknown,turnId:string):ConversationItem|undefined {
  const item=record(value),id=identifier(item.id);if(!id)return;
  const out:ConversationItem={id,turn_id:turnId,kind:"tool_progress"};
  if(item.type==="userMessage"){
    const chunks=Array.isArray(item.content)?item.content.filter(x=>record(x).type==="text").map(x=>record(x).text).filter((x):x is string=>typeof x==="string"):[];
    const summaries=chunks.map(requestText).filter((x):x is string=>x!==undefined);if(!summaries.length)return;out.kind="user_message";out.text=summaries.join("\n");
  }else if(item.type==="agentMessage"&&typeof item.text==="string"){out.kind="assistant_message";out.text=item.text;}
  else if(["commandExecution","fileChange","mcpToolCall","dynamicToolCall","collabAgentToolCall","webSearch","imageView"].includes(String(item.type))){
    out.tool_type=String(item.type);if(typeof item.status==="string")out.status=item.status;
    if(typeof item.durationMs==="number")out.duration_ms=item.durationMs;
    if(item.type==="commandExecution"){if(typeof item.command==="string")out.command=item.command;if(typeof item.aggregatedOutput==="string")out.output=item.aggregatedOutput;if(typeof item.exitCode==="number")out.exit_code=item.exitCode;}
    if(item.type==="fileChange"&&Array.isArray(item.changes)){
      out.files=item.changes.slice(0,20).flatMap(raw=>{
        const f=record(raw),kind=record(f.kind);if(typeof f.path!=="string"||!["add","delete","update"].includes(String(kind.type)))return [];
        if(typeof f.diff!=="string")return [{path:f.path,change:kind.type as ConversationFile["change"]}];
        if(f.diff.length>131072){out.truncated=true;return [{path:f.path,change:kind.type as ConversationFile["change"]}];}
        // Codex FileChange Add/Deleteのdiffはraw content。Updateだけがunified diff。
        if(kind.type==="add"||kind.type==="delete"){
          const lines=f.diff.length===0?0:f.diff.split("\n").length-(f.diff.endsWith("\n")?1:0);
          return [{path:f.path,change:kind.type as ConversationFile["change"],additions:kind.type==="add"?lines:0,deletions:kind.type==="delete"?lines:0}];
        }
        let additions=0,deletions=0,inHunk=false;
        for(const line of f.diff.split("\n")){
          if(line.startsWith("diff --git ")){inHunk=false;continue;}
          if(line.startsWith("@@")){inHunk=true;continue;}
          if(!inHunk&&/^(?:---|\+\+\+) /.test(line))continue;
          if(line.startsWith("+"))additions++;else if(line.startsWith("-"))deletions++;
        }
        return [{path:f.path,change:kind.type as ConversationFile["change"],additions,deletions}];
      });if(item.changes.length>20)out.truncated=true;
    }
    if(item.type==="collabAgentToolCall"){
      const tools=["spawnAgent","sendInput","resumeAgent","wait","closeAgent","sendMessage","followupTask","interruptAgent","listAgents"];
      if(tools.includes(String(item.tool)))out.tool_name=String(item.tool);
      if(typeof item.prompt==="string"){const summary=requestText(item.prompt);if(summary!==undefined)out.input=summary;}
      const states=Object.values(record(item.agentsStates));if(states.length>20)out.truncated=true;
      const lines=states.slice(0,20).map(raw=>{const state=record(raw);const status=["pendingInit","running","interrupted","completed","errored","shutdown","notFound"].includes(String(state.status))?String(state.status):"";const message=typeof state.message==="string"?state.message:"";return [status,message].filter(Boolean).join(": ");}).filter(Boolean);
      if(lines.length)out.output=lines.join("\n");
    }
    if(item.type==="mcpToolCall"||item.type==="dynamicToolCall"){
      out.tool_name=[item.server??item.namespace,item.tool].filter(x=>typeof x==="string").join(".");
      let args=record(item.arguments);if(typeof item.arguments==="string"&&item.arguments.length<=32768){try{args=record(JSON.parse(item.arguments));}catch{}}
      const inputs=[];for(const key of ["command","code","query","path"]){if(typeof args[key]==="string")inputs.push(`${key}: ${args[key]}`);}if(inputs.length)out.input=inputs.join("\n");
      const content=item.type==="mcpToolCall"?record(item.result).content:item.contentItems;
      if(Array.isArray(content)&&content.length>20)out.truncated=true;
      if(Array.isArray(content))out.output=content.slice(0,20).filter(x=>["text","inputText"].includes(String(record(x).type))).map(x=>record(x).text).filter(x=>typeof x==="string").join("\n");
      if(typeof record(item.error).message==="string")out.error=record(item.error).message as string;
    }
    if(item.type==="webSearch"&&typeof item.query==="string")out.input=item.query;
  }else return;
  return sanitizeConversationItem(out);
}
export function projectHistory(value:unknown):{threadId:string|undefined;items:ConversationItem[];truncated:boolean} {
  const thread=record(record(value).thread),turns=Array.isArray(thread.turns)?thread.turns:[],items:ConversationItem[]=[];
  let truncated=turns.length>100,bytes=0,inspected=0;
  // 最新から採用し上限でprojection自体を止める。古い重いtool payloadを先に処理しない。
  outer:for(let ti=turns.length-1;ti>=Math.max(0,turns.length-100);ti--){
    if(items.length>=200||inspected>=1000){truncated=true;break;}
    const turn=record(turns[ti]),id=identifier(turn.id);if(!id)continue;
    const source=Array.isArray(turn.items)?turn.items:[];if(source.length>200)truncated=true;
    for(let ii=source.length-1;ii>=Math.max(0,source.length-200);ii--){
      if(items.length>=200||inspected>=1000){truncated=true;break outer;}
      inspected++;const projected=projectItem(source[ii],id);if(!projected)continue;
      const size=Buffer.byteLength(JSON.stringify(projected));if(bytes+size>524288){truncated=true;break outer;}
      bytes+=size;items.push(projected);if(projected.truncated)truncated=true;
    }
  }
  return {threadId:typeof thread.id==="string"?thread.id:undefined,items:items.reverse(),truncated};
}
export function projectNotification(method:string|undefined,value:unknown):Omit<ObservationEvent,"sequence"|"observed_at">|undefined {
  const p=record(value),turn=record(p.turn),turnId=identifier(p.turnId)??identifier(turn.id),itemId=identifier(p.itemId)??identifier(record(p.item).id);
  if(["turn/started","turn/completed","item/started","item/completed","serverRequest/resolved"].includes(method??""))return {kind:method!,...(turnId?{turn_id:turnId}:{}),...(itemId?{item_id:itemId}:{})};
  // deltaは途中でcredentialが分割され得る。本文は完成済みitem/historyからだけ投影する。
  if(method==="item/agentMessage/delta"&&turnId&&itemId)return {kind:method,turn_id:turnId,item_id:itemId};
}
