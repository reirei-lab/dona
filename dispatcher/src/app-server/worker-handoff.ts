import type {AgentRecord} from "./store.js";

/** 診断protocol。receipt/activation capabilityではなく、現行gateを解除しない。 */
export const workerHandoffProtocol = 1;
export const workerHandoffContractBlockers = [
  "runtime_host_strategy_unverified",
  "isolated_result_grant_unverified",
  "release_schema_pair_unverified",
  "terminal_owner_fence_unverified",
] as const;

export type WorkerHandoffBlocker = typeof workerHandoffContractBlockers[number]
  | "same_turn_unverified" | "attempt_binding_unavailable" | "worker_observation_unknown"
  | "process_observation_unavailable" | "worker_identity_mismatch"
  | "pending_request_unsupported" | "expired_request_authority" | "waiting_unsupported";

/** private Runtime UDS専用。path、prompt、質問本文、credentialを含めない。 */
export interface WorkerHandoffObservation {
  name:string;
  generation:string;
  attempt_id:string|null;
  thread_id:string|null;
  turn_id:string|null;
  state:AgentRecord["state"];
  connected:boolean;
  process_binding:"matched"|"absent"|"mismatch"|"unavailable";
  request_state:"none"|"pending"|"expired"|"pending_and_expired";
  blockers:WorkerHandoffBlocker[];
}

export interface WorkerHandoffInventory {
  schema_version:1;
  protocol:typeof workerHandoffProtocol;
  handoff_enabled:false;
  activation_allowed:false;
  compatibility:"unverified";
  snapshot_scope:"page";
  observed_at:string;
  blockers:readonly WorkerHandoffBlocker[];
  items:WorkerHandoffObservation[];
  next:string|null;
}

export function workerHandoffBlockers(observation:Omit<WorkerHandoffObservation,"blockers">):WorkerHandoffBlocker[] {
  // thread/turnの保存値はread-only再接続での同一active turn証明ではない。
  const blockers:WorkerHandoffBlocker[]=["same_turn_unverified"];
  if(!observation.attempt_id)blockers.push("attempt_binding_unavailable");
  if(observation.state==="unknown"||!observation.connected)blockers.push("worker_observation_unknown");
  if(observation.process_binding==="unavailable")blockers.push("process_observation_unavailable");
  if(observation.process_binding==="mismatch")blockers.push("worker_identity_mismatch");
  if(observation.state==="waiting")blockers.push("waiting_unsupported");
  if(["pending","pending_and_expired"].includes(observation.request_state))blockers.push("pending_request_unsupported");
  if(["expired","pending_and_expired"].includes(observation.request_state))blockers.push("expired_request_authority");
  return blockers;
}
