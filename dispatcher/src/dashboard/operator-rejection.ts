import {z} from 'zod';
import type {OperatorCommandDatabase} from './operator-commands.js';

export const commandRejectionSchema=z.strictObject({rejection:z.strictObject({
  request_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  operation:z.enum(['create','cancel','question_reply','native_approval','external_approval']),
  code:z.enum(['invalid','conflict','unavailable']),not_committed:z.literal(true),
})});
type RejectedOperation=z.infer<typeof commandRejectionSchema>['rejection']['operation'];
export function commandRejection(request_id:string,operation:RejectedOperation,code:'invalid'|'conflict'|'unavailable'='conflict') {
  return commandRejectionSchema.parse({rejection:{request_id,operation,code,not_committed:true}});
}
/** Only call after a synchronous command transaction has rolled back. Storage,
 * transport and post-commit errors deliberately remain ambiguous. precommit is
 * reserved for a caller that has not invoked the command mutation at all. */
export function rejectedCommand(database:OperatorCommandDatabase,token:string,operation:string,input:unknown,error:unknown,precommit=false) {
  if(!['create','cancel','question_reply','native_approval'].includes(operation))throw error;
  const parsed=z.object({request_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)}).safeParse(input);
  if(!parsed.success)throw error;
  const known=error instanceof z.ZodError || error instanceof Error && [
    'task_revision_conflict','task_terminal','task_question_not_current','task_approval_not_current',
    'local_dashboard_command_invalid','local_dashboard_active_task_limit',
    'local_dashboard_command_conflict','local_dashboard_question_already_answered',
    'local_dashboard_owner_mismatch',
  ].includes(error.message);
  if(!precommit&&!known)throw error;
  // A rejected replay is not proof that the original command was unaccepted.
  const cap=operation==='cancel'?'tasks:cancel':operation==='native_approval'?'approvals:native':'tasks:submit';
  const prior=database.operatorAuth.withSession(token,cap,authority=>database.getLocalDashboardReceipt(authority,parsed.data.request_id));
  if(prior)throw error;
  return commandRejection(parsed.data.request_id,operation as RejectedOperation,error instanceof z.ZodError?'invalid':'conflict');
}
