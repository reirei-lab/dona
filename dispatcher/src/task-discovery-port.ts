/** #170の未配線contract。status/read grantをdiscoverへ変換しない。
 * shared queryへのadapter・API/MCP・issuerは別の採用判断を要する。 */
export interface DiscoveryScope {
 tenant_id:string; workspace_id:string; principal_id:string;
 destination:{workspace_id:string;channel_id:string;thread_ts:string};
 principal_revision:number; policy_revision:number;
}
export interface DiscoveryCandidate {
 task_id:string; job_id:string; repository_node_id:string; issue_node_id:string;
 binding_revision:number; resource_revision:number;
}
/** trusted composition rootが現在のprincipal/binding/grant/disclosureを確認する。
 * discoverだけの許可であり、Result読出し・write authorityは一切含まない。 */
export interface TaskDiscoveryPort {
 project(scope:Readonly<DiscoveryScope>,candidate:Readonly<DiscoveryCandidate>):
   Readonly<{task_id:string;job_id:string}> | null;
}
export const denyTaskDiscoveryPort:TaskDiscoveryPort=Object.freeze({project:()=>null});
