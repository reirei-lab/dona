import { parseJobResultEnvelope } from "./validation.js";
import { jobResultEnvelopeMaxBytes } from "./job-result-publish.js";

// エラー本文も未信頼データ。既知のprivate値と典型的なcredential/URL/pathを除き、説明をboundedに返す。
export function projectJobError(row: Record<string, unknown>): string | null {
  if (typeof row.last_error_message !== "string") return null;
  let message = row.last_error_message;
  const privateValues = ["objective", "workspace_path", "result_path", "agent_name", "herdr_workspace_id", "herdr_pane_id"]
    .map((key) => row[key]).filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const value of privateValues) message = message.split(value).join("[redacted]");
  return message
    .replace(/\b(?:Bearer\s+\S+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+))/gi, "[redacted]")
    .replace(/\b(?:https?|file):\/\/[^\s<>"']+/gi, "[URL]")
    .replace(/(?:[A-Za-z]:\\|~?\/)[^\s<>"']+/g, "[path]")
    .slice(0, 2_000);
}

// Resultの追加自由fieldやactionを集約読取へ広げず、保存済み受理上限を維持する。
export function projectCompletionJob(job:Record<string,unknown>):Record<string,unknown> {
  let result_json:string|null=null;
  if(typeof job.result_json==="string"&&typeof job.job_id==="string"&&Buffer.byteLength(job.result_json,"utf8")<=jobResultEnvelopeMaxBytes) {
    try {
      const result=parseJobResultEnvelope(JSON.parse(job.result_json),job.job_id);
      result_json=JSON.stringify({schema_version:1,job_id:result.job_id,status:result.status,summary:result.summary,
        ...(result.output?{output:result.output}:{}),...(result.artifacts?{artifacts:result.artifacts}:{}),actions:[],completed_at:result.completed_at});
    } catch { /* 不正・過大Resultをraw fallbackしない。 */ }
  }
  const keys=["job_id","status","created_at","updated_at","completed_at","last_error_code"];
  return {...Object.fromEntries(keys.filter(key=>key in job).map(key=>[key,job[key]])),result_json,last_error_message:projectJobError(job)};
}
