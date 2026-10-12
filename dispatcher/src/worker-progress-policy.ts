import {createHash} from "node:crypto";
import {z} from "zod";
import {credentialShaped} from "./credential-shaped.js";
import {workerReportSchema} from "./worker-messaging.js";
import {jobStatuses} from "./types.js";
import {stableStringify} from "./validation.js";

export const progressActions=["ack_internal","ask_worker","instruct_worker","aggregate_wait","report_to_user","ask_user"] as const;
const instant=z.string().datetime();
const phase=z.enum(jobStatuses);
const projection=z.strictObject({message_id:z.string().min(1).max(80),payload:z.lazy(()=>workerReportSchema.shape.payload),occurred_at:instant,accepted_at:instant});
const member=z.strictObject({job_id:z.string().min(1).max(80),phase,report:projection.optional()});
/** Only the server's owner-checked, transaction-consistent ledger projection may supply this context. */
export const progressContextSchema=z.strictObject({event_id:z.string().min(1).max(80),job_id:z.string().min(1).max(80),
 reserved_high_risk_ids:z.array(z.string().max(80)).max(64).default([]),presentation_pending:z.boolean().default(false),report_current:z.boolean().default(true),current:z.boolean(),desired_state:z.enum(["running","paused","cancelled"]),phase,now:instant,
 report:projection.optional(),silence_since:instant.optional(),members:z.array(member).min(1).max(32),
 group_attention:z.boolean(),group_terminal:z.boolean(),context_complete:z.boolean(),
 previous:z.strictObject({high_risk_message_ids:z.array(z.string().max(80)).max(64).optional(),fingerprint:z.string(),group_fingerprint:z.string().optional(),severity:z.enum(["low","medium","high"]).optional(),eta_minutes:z.number().int().nonnegative().optional(),
  action:z.enum(progressActions),decided_at:instant,message_id:z.string().optional()}).optional(),
 last_user_report_at:instant.optional(),last_presentation_at:instant.optional(),last_presentation_fingerprint:z.string().optional(),pending_instruction:z.strictObject({message_id:z.string(),state:z.enum(["pending","unknown","delivered"])}).optional(),
 silence_threshold_ms:z.number().int().min(60000).max(86400000).default(900000),minimum_report_interval_ms:z.number().int().min(1000).max(86400000).default(60000)});
export type ProgressContext=z.infer<typeof progressContextSchema>;
export interface ProgressDecision {
 version:1;action:typeof progressActions[number];reason:string;fingerprint:string|null;
 target:{job_id:string;message_id?:string}|null;
 safe_projection?:{summary?:string;question?:string;options?:string[];members?:Array<{job_id:string;phase:string;summary?:string}>};
 signals:{novelty:boolean;human_required:boolean;silence:boolean;risk_escalation:boolean;eta_changed:boolean};
 observed?:{high_risk_message_ids?:string[];group_fingerprint?:string;severity?:"low"|"medium"|"high";eta_minutes?:number};
 operation?:"read_instruction_receipt"|"deliver_existing_instruction"|"request_status";
}
const rank={low:0,medium:1,high:2};
const normalized=(s:string)=>s.normalize("NFKC").replace(/\s+/gu," ").trim();
const hash=(value:unknown)=>createHash("sha256").update(stableStringify(value)).digest("hex");
const denied=(s:string)=>credentialShaped.test(s)||/(?:[/\\]|https?:|file:|\$\(|`|\b(?:stdout|stderr)\b|\b(?:curl|wget|bash|sudo|npm|git|python)\s)/i.test(s);
const reportText=(report:ProgressContext["report"])=>report?Object.values(report.payload).flatMap(v=>typeof v==="string"?[v]:Array.isArray(v)?v:[]).join(" "):"";
const emptySignals=()=>({novelty:false,human_required:false,silence:false,risk_escalation:false,eta_changed:false});

/** Closed, deterministic selection; never performs worker control or external posting. */
export function evaluateProgress(raw:unknown):ProgressDecision {
 let c:ProgressContext;
 try{c=progressContextSchema.parse(raw);}catch{return {version:1,action:"ack_internal",reason:"policy_input_invalid",fingerprint:null,target:null,signals:emptySignals()};}
 const target={job_id:c.job_id,...(c.report?{message_id:c.report.message_id}:{})};
 const result:ProgressDecision={version:1,action:"ack_internal",reason:"no_action",fingerprint:null,target,signals:emptySignals()};
 if(!c.current||c.desired_state!=="running"||!["running","blocked"].includes(c.phase)){result.reason="attempt_unavailable";return result;}
 const urgent=c.report&&(["question","decision_request"].includes(c.report.payload.kind)||(c.report.payload.kind==="risk"&&c.report.payload.severity==="high"));
 if(c.group_terminal||(c.group_attention&&!urgent)){result.reason="terminal_notification_priority";return result;}
 if(!c.context_complete||!c.members.some(m=>m.job_id===c.job_id&&m.phase===c.phase)||new Set(c.members.map(m=>m.job_id)).size!==c.members.length){result.reason="context_incomplete";return result;}
 if(denied(reportText(c.report))){result.reason="unsafe_projection";result.target=null;return result;}
 if(urgent){c.members=c.members.map(m=>denied(reportText(m.report))?{job_id:m.job_id,phase:m.phase}:m);}
 else if(c.members.some(m=>denied(reportText(m.report)))){result.reason="unsafe_projection";result.target=null;return result;}
 if(!c.report_current){result.reason="stale_report";return result;}
 const existingInstruction=()=>{
  if(!c.pending_instruction||c.pending_instruction.state==="delivered")return false;
  result.action="instruct_worker";result.reason="existing_instruction_receipt";result.target={job_id:c.job_id,message_id:c.pending_instruction.message_id};
  result.operation=c.pending_instruction.state==="unknown"?"read_instruction_receipt":"deliver_existing_instruction";return true;
 };
 const now=Date.parse(c.now);
 if(!c.report){
  if(existingInstruction())return result;
  const silence=c.silence_since!==undefined&&now-Date.parse(c.silence_since)>=c.silence_threshold_ms;
  result.signals.silence=silence;
  if(silence&&!(c.previous?.action==="ask_worker"&&now-Date.parse(c.previous.decided_at)<c.silence_threshold_ms)){
   result.action="ask_worker";result.reason="silence_threshold";result.operation="request_status";
  }else result.reason=silence?"silence_request_already_recorded":"no_report";
  return result;
 }
 const payload=c.report.payload;
 const canonical=Object.fromEntries(Object.entries(payload).map(([k,v])=>[k,typeof v==="string"?normalized(v):Array.isArray(v)?v.map(normalized):v]));
 const fingerprint=hash(canonical);result.fingerprint=fingerprint;
 const groupFingerprint=hash(c.members.map(m=>({job_id:m.job_id,phase:m.phase,payload:m.report?Object.fromEntries(Object.entries(m.report.payload).map(([k,v])=>[k,typeof v==="string"?normalized(v):Array.isArray(v)?v.map(normalized):v])):null})).sort((a,b)=>a.job_id.localeCompare(b.job_id)));
 result.signals.novelty=fingerprint!==c.previous?.fingerprint||!!(c.previous?.group_fingerprint&&groupFingerprint!==c.previous.group_fingerprint);
 const etaMatch=normalized(reportText(c.report)).match(/(?:残り|あと|見込み)\s*([0-9]{1,5})\s*分/u),eta=etaMatch?Number(etaMatch[1]):undefined;
 const highRiskIds=[...new Set([...(payload.kind==="risk"&&payload.severity==="high"?[c.report.message_id]:[]),...c.members.flatMap(m=>m.report?.payload.kind==="risk"&&m.report.payload.severity==="high"?[m.report.message_id]:[])])];
 result.observed={high_risk_message_ids:highRiskIds,group_fingerprint:groupFingerprint,...(payload.kind==="risk"?{severity:payload.severity}:{}),...(eta!==undefined?{eta_minutes:eta}:{})};
 result.signals.eta_changed=eta!==undefined&&c.previous?.eta_minutes!==undefined&&Math.abs(eta-c.previous.eta_minutes)>=Math.max(5,c.previous.eta_minutes*0.25);
 result.signals.risk_escalation=(payload.kind==="risk"&&payload.severity!=="high"&&rank[payload.severity]>(c.previous?.severity?rank[c.previous.severity]:0))
  ||highRiskIds.some(id=>!c.reserved_high_risk_ids.includes(id));
 if(payload.kind==="question"||payload.kind==="decision_request"){
  result.signals.human_required=true;
  if(c.previous?.message_id===c.report.message_id&&c.previous.action==="ask_user"){result.reason="question_already_recorded";return result;}
  result.action="ask_user";result.reason="human_decision_required";result.safe_projection={question:payload.question,...(payload.kind==="decision_request"?{options:payload.options}:{})};return result;
 }
 // Questions and risk/ETA escalation must not disappear behind an unrelated instruction receipt.
 if(!result.signals.risk_escalation&&!result.signals.eta_changed&&existingInstruction())return result;
 const heartbeat=payload.kind==="checkpoint"&&/^(?:(?:作業|調査|確認)(?:を)?(?:継続(?:して|し)|続けて)います|(?:作業|調査|確認)中です)[。.!！]?$/u.test(normalized(payload.summary));
 if(heartbeat&&!result.signals.risk_escalation&&!result.signals.eta_changed){result.signals.novelty=false;result.reason="heartbeat_without_change";return result;}
 if(payload.kind==="checkpoint"&&c.last_presentation_fingerprint===groupFingerprint){result.reason="group_progress_already_reserved";return result;}
 if(c.presentation_pending&&!result.signals.risk_escalation&&!result.signals.eta_changed){result.action="aggregate_wait";result.reason="presentation_undelivered";return result;}
 if(!result.signals.novelty&&!result.signals.risk_escalation&&!result.signals.eta_changed&&c.previous?.action!=="aggregate_wait"){result.reason="duplicate_report";return result;}
 const live=c.members.filter(m=>["running","blocked"].includes(m.phase));
 if(!result.signals.risk_escalation&&!result.signals.eta_changed&&live.length>1&&live.some(m=>!m.report||Date.parse(m.report.accepted_at)<Date.parse(c.report!.accepted_at)-30000)&&now-Date.parse(c.report.accepted_at)<30000){result.action="aggregate_wait";result.reason="sibling_reports_pending";return result;}
 const lastReport=Math.max(c.last_user_report_at?Date.parse(c.last_user_report_at):0,c.last_presentation_at?Date.parse(c.last_presentation_at):0);
 if(!result.signals.risk_escalation&&!result.signals.eta_changed&&lastReport&&now-lastReport<c.minimum_report_interval_ms){result.action="aggregate_wait";result.reason="report_cadence";return result;}
 result.action="report_to_user";result.reason=result.signals.risk_escalation?"risk_escalation":result.signals.eta_changed?"eta_drift":"new_progress";
 result.safe_projection={summary:payload.summary,members:c.members.map(m=>({job_id:m.job_id,phase:m.phase,...(m.report?{summary:Array.from(reportText(m.report)).slice(0,240).join("")}:{})}))};return result;
}
