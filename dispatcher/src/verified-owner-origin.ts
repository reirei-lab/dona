import type { DispatcherDatabase } from "./database.js";
import { stableStringify } from "./validation.js";

/** 永続通知receiptとimmutable ownerを辿る。自由記述のsource IDだけでは継承しない。 */
export function resolveVerifiedSlackOwner(database:DispatcherDatabase,eventId:string) {
  try {
    const seen=new Set<string>(),path:Array<Record<string,unknown>>=[];
    for(let depth=0;depth<16;depth++) {
      if(seen.has(eventId))return;seen.add(eventId);
      const event=database.get(eventId),binding=database.getEventJobBinding(eventId);
      if(!event||binding?.owner.kind!=="slack_thread"||binding.destination.kind!=="slack_thread"||
        !event.reply_target_json||stableStringify(JSON.parse(event.reply_target_json))!==stableStringify(binding.destination))return;
      if(event.source==="slack") {
        const principal=database.getVerifiedPrincipalBinding(eventId);
        if(!principal||principal.revoked_at!==null||principal.workspace_id!==binding.owner.workspace_id||
          path.some(link=>link.actor_id!==principal.principal_id))return;
        return {origin:event,principal,path};
      }
      if(event.source!=="dona_job")return;
      const subject=JSON.parse(event.subject_json),payload=JSON.parse(event.payload_json),job=database.getJob(payload.job_id);
      if(!job||subject.job_id!==job.job_id||subject.source_event_id!==job.source_event_id||job.source_event_id===eventId)return;
      const group=database.getJobGroup(job.source_event_id);
      if(job.completion_event_id!==eventId&&group?.attention_event_id!==eventId&&group?.all_terminal_event_id!==eventId)return;
      const parentBinding=database.getEventJobBinding(job.source_event_id);
      if(!parentBinding||stableStringify(parentBinding)!==stableStringify(binding))return;
      path.push({event_id:eventId,source_event_id:job.source_event_id,job_id:job.job_id,actor_id:job.actor_id,
        binding,subject_json:event.subject_json,reply_target_json:event.reply_target_json});
      eventId=job.source_event_id;
    }
  } catch {return;}
}
