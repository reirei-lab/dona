import type {AgentRecord} from "./store.js";

export interface ConversationIdentity {
  name:string;generation:string;role:"main"|"worker";thread_id:string|null;attempt_id:string|null;
  archived?:boolean;
  state:AgentRecord["state"];connected:boolean;observed_at:string;
}
export interface ConversationItem {id:string;turn_id:string;kind:"assistant_message"|"tool_progress";text?:string;status?:string;tool_type?:string;truncated?:boolean}
export interface ObservationEvent {sequence:number;kind:string;turn_id?:string;item_id?:string;text?:string;observed_at:string}
export interface ConversationSnapshot extends ConversationIdentity {
  items:ConversationItem[];events:ObservationEvent[];cursor:number;oldest_sequence:number;gap:boolean;truncated:boolean;
}
export const record=(x:unknown):Record<string,unknown>=>x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:{};
const identifier=(x:unknown):string|undefined=>typeof x==="string"&&/^[a-zA-Z0-9_-]{1,160}$/.test(x)?x:undefined;
/** ユーザー項目にはDONA_JOB・イベント契約が入るため、全文を除外する。toolの入力・出力も保存しない。 */
export function projectItem(value:unknown,turnId:string):ConversationItem|undefined {
  const item=record(value),id=identifier(item.id);if(!id)return;
  if(item.type==="agentMessage"&&typeof item.text==="string")return {id,turn_id:turnId,kind:"assistant_message",text:item.text.slice(0,8192),...(item.text.length>8192?{truncated:true}:{})};
  if(["commandExecution","fileChange","mcpToolCall","dynamicToolCall","webSearch","imageView"].includes(String(item.type)))return {id,turn_id:turnId,kind:"tool_progress",tool_type:String(item.type),...(["inProgress","completed","failed","declined"].includes(String(item.status))?{status:String(item.status)}:{})};
}
export function projectHistory(value:unknown):{threadId:string|undefined;items:ConversationItem[];truncated:boolean} {
  const thread=record(record(value).thread),turns=Array.isArray(thread.turns)?thread.turns:[],items:ConversationItem[]=[];
  let truncated=turns.length>100;
  for(const raw of turns.slice(-100)){
    const turn=record(raw),id=identifier(turn.id);if(!id)continue;
    const source=Array.isArray(turn.items)?turn.items:[];if(source.length>200)truncated=true;
    for(const item of source.slice(-200)){const projected=projectItem(item,id);if(projected){items.push(projected);if(projected.truncated)truncated=true;}}
  }
  const bounded:ConversationItem[]=[];let bytes=0;
  for(const item of items.slice(-200).reverse()){const size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>524288){truncated=true;break;}bytes+=size;bounded.unshift(item);}
  return {threadId:typeof thread.id==="string"?thread.id:undefined,items:bounded,truncated:truncated||items.length>200};
}
export function projectNotification(method:string|undefined,value:unknown):Omit<ObservationEvent,"sequence"|"observed_at">|undefined {
  const p=record(value),turn=record(p.turn),turnId=identifier(p.turnId)??identifier(turn.id),itemId=identifier(p.itemId)??identifier(record(p.item).id);
  if(["turn/started","turn/completed","item/started","item/completed","serverRequest/resolved"].includes(method??""))return {kind:method!,...(turnId?{turn_id:turnId}:{}),...(itemId?{item_id:itemId}:{})};
  if(method==="item/agentMessage/delta"&&typeof p.delta==="string"&&turnId&&itemId)return Buffer.byteLength(p.delta)>512?{kind:"gap"}:{kind:method,turn_id:turnId,item_id:itemId,text:p.delta};
}
