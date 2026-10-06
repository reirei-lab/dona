import assert from "node:assert/strict";
import { test } from "node:test";
import { setup, scope } from "./web/fixtures.js";
import { openSecurityDatabase } from "../src/audit/coordination.js";
import { installTaskGrantSchema, TaskGrantRepository, type TaskGrant, type GrantEvaluation, type GrantWrite, type TaskGrantIssuer } from "../src/task-grants.js";

const start="2026-09-19T00:00:00.000Z",end="2026-09-19T01:00:00.000Z";
const principal={kind:"human" as const,id:"owner",workspace_id:"workspace",identity_binding_revision:1,authz_revision:1};
const resource={task_id:"task_01m48e6bt7vk1jmapj8vzj5y12",repository_full_name:"reirei-lab/dona",repository_node_id:"repository",issue_node_id:"issue",issue_number:168,resource_revision:1,binding_revision:1};
const destination={workspace_id:"workspace",channel_id:"channel",thread_ts:"123.456"};
const approval={event_id:"event",typed_plan_ref:"plan",plan_sha256:"a".repeat(64)};
function grant(id="root"):TaskGrant{return {grant_id:id,principal:{...principal},resources:[{...resource}],epic:null,operations:["status","read"],destinations:[{...destination}],approval:{...approval},starts_at:start,expires_at:end,revoked_at:null,revision:1,parent:null};}
function query(id="root"):GrantEvaluation{return {grant_id:id,revision:1,principal:{...principal},resource:{...resource},operation:"read",destination:{...destination},epic_membership_revision:null};}
function fixture(t:{after(fn:()=>void):void}){
 const f=setup(t);f.setNow(start);installTaskGrantSchema(f.db);
 let authorized=true,binding=true,proof=approval;
 const issuer:TaskGrantIssuer={authorize:(command:Readonly<GrantWrite>)=>authorized?{issuer_id:"issuer",approval:command.kind==="put"?proof:null}:null,
  currentBinding:()=>binding};
 const repo=new TaskGrantRepository(f.db,f.providers,scope,issuer);
 assert.equal(repo.write("initialize",{kind:"initialize"}).status,"succeeded");
 return {...f,repo,issuer,deny:()=>{authorized=false;},invalidate:()=>{binding=false;},setApproval:(value:typeof approval)=>{proof=value;}};
}
test("fresh・upgrade・reopenでもgrant scopeを監査rootに束縛しexpiryを保つ",t=>{
 const f=fixture(t);assert.equal(f.repo.write("put",{kind:"put",expected_revision:0,grant:grant()}).status,"succeeded");
 installTaskGrantSchema(f.db);assert.equal(f.repo.evaluate("read",query()),true);
 const second=openSecurityDatabase(f.filename);second.pragma("foreign_keys=ON");second.pragma("synchronous=FULL");t.after(()=>second.close());
 const repo=new TaskGrantRepository(second,f.providers,scope,f.issuer);assert.equal(repo.evaluate("reopen",query()),true);
 f.setNow(end);assert.equal(repo.evaluate("expiry",query()),false);
 assert.equal(repo.write("expired_update",{kind:"put",expected_revision:1,grant:{...grant(),revision:2,expires_at:"2026-09-19T02:00:00.000Z"}}).status,"denied");
});
test("principal/task/repo/operation/destination/revisionのtamperとfuture childを拒否",t=>{
 const f=fixture(t);const g=grant();g.epic={repository_node_id:"repository",epic_node_id:"epic",membership_revision:1,child_issue_node_ids:["issue"]};
 f.repo.write("put",{kind:"put",expected_revision:0,grant:g});
 const q={...query(),epic_membership_revision:1};assert.equal(f.repo.evaluate("ok",q),true);
 const cases:GrantEvaluation[]=[{...q,principal:{...principal,id:"other"}},{...q,principal:{...principal,kind:"bot"}},
 {...q,principal:{...principal,workspace_id:"other"}},{...q,principal:{...principal,authz_revision:2}},
 {...q,resource:{...resource,task_id:"task_01m48e6bt7vk1jmapj8vzj5y13"}},{...q,resource:{...resource,repository_node_id:"other"}},
 {...q,resource:{...resource,issue_node_id:"future"}},{...q,resource:{...resource,binding_revision:2}},
 {...q,operation:"cancel"},{...q,operation:"merge"},{...q,operation:"production"},
 {...q,destination:{...destination,channel_id:"public"}},{...q,destination:{...destination,thread_ts:"999.000"}},
 {...q,epic_membership_revision:2},{...q,revision:2}];
 cases.forEach((c,i)=>assert.equal(f.repo.evaluate("deny"+i,c),false));
 f.invalidate();assert.equal(f.repo.evaluate("binding_revoke",q),false);
});
test("縮小委譲のdecision matrix・親revoke伝播・明示service act-as",t=>{
 const f=fixture(t);f.repo.write("parent",{kind:"put",expected_revision:0,grant:grant()});
 const child:TaskGrant={...grant("child"),operations:["read"],principal:{...principal,kind:"service",id:"service"},parent:{grant_id:"root",revision:1}};
 assert.equal(f.repo.write("child",{kind:"put",expected_revision:0,grant:child}).status,"succeeded");
 assert.equal(f.repo.evaluate("child_read",{...query("child"),principal:child.principal}),true);
 const expanded:TaskGrant[]=[{...child,operations:["cancel"]},{...child,resources:[{...resource,issue_node_id:"future"}]},
 {...child,destinations:[{...destination,channel_id:"public"}]},{...child,starts_at:"2026-09-18T23:59:59.000Z"},
 {...child,expires_at:"2026-09-19T02:00:00.000Z"},{...child,parent:{grant_id:"root",revision:2}}];
 expanded.forEach((g,i)=>assert.equal(f.repo.write("expand"+i,{kind:"put",expected_revision:0,grant:{...g,grant_id:"bad"+i}}).status,"denied"));
 assert.equal(f.repo.write("revoke",{kind:"revoke",grant_id:"root",expected_revision:1}).status,"succeeded");
 assert.equal(f.repo.evaluate("child_revoked",{...query("child"),principal:child.principal}),false);
 assert.equal(f.repo.write("no_reuse",{kind:"put",expected_revision:2,grant:{...grant(),revision:3}}).status,"denied");
});
test("有限集合の縮小property matrixで操作集合の任意追加を拒否",t=>{
 const f=fixture(t);f.repo.write("parent",{kind:"put",expected_revision:0,grant:grant()});
 const operations=["status","read","cancel","merge","production"] as const;
 for(let mask=1;mask<32;mask++){
  const selected=operations.filter((_,i)=>mask&(1<<i));const g={...grant("child"+mask),parent:{grant_id:"root",revision:1},operations:selected};
  assert.equal(f.repo.write("subset"+mask,{kind:"put",expected_revision:0,grant:g}).status,selected.every(v=>["status","read"].includes(v))?"succeeded":"denied");
 }
});
test("並行connectionのCAS・親revision変更・approval再承認を検証",t=>{
 const f=fixture(t);f.repo.write("put",{kind:"put",expected_revision:0,grant:grant()});
 const child={...grant("child"),parent:{grant_id:"root",revision:1}};f.repo.write("child",{kind:"put",expected_revision:0,grant:child});
 const second=openSecurityDatabase(f.filename);second.pragma("foreign_keys=ON");second.pragma("synchronous=FULL");t.after(()=>second.close());
 const repo=new TaskGrantRepository(second,f.providers,scope,f.issuer);
 assert.equal(f.repo.write("update",{kind:"put",expected_revision:1,grant:{...grant(),revision:2,operations:["read"]}}).status,"succeeded");
 assert.equal(repo.write("stale",{kind:"revoke",grant_id:"root",expected_revision:1}).status,"denied");
 assert.equal(repo.evaluate("child_old_parent",query("child")),false);
 assert.equal(repo.write("fake_approval",{kind:"put",expected_revision:2,grant:{...grant(),revision:3,approval:{...approval,event_id:"fake"}}}).status,"denied");
});
test("issuer deny・非同期偽capability・生SQL改変・clock異常をfail closed",t=>{
 const f=fixture(t);f.deny();assert.equal(f.repo.write("deny",{kind:"put",expected_revision:0,grant:grant()}).status,"denied");
 assert.throws(()=>new TaskGrantRepository(f.db,f.providers,scope,{authorize:async()=>null,currentBinding:()=>true} as unknown as typeof f.issuer));
 f.db.prepare("UPDATE task_grant_state SET state_json=?").run(JSON.stringify({version:1,scope,grants:[grant()]}));
 assert.throws(()=>f.repo.evaluate("tamper",query()),/task_grant_unverified/);
 const clock=fixture(t);clock.repo.write("put",{kind:"put",expected_revision:0,grant:grant()});clock.setNow("2026-09-18T23:59:59.000Z");
 assert.throws(()=>clock.repo.evaluate("clock_backward",query()),/task_grant_unverified/);
});
test("start境界・異常boot・expiry後restart・未知migrationを拒否",t=>{
 const f=fixture(t);const delayed={...grant(),starts_at:"2026-09-19T00:00:01.000Z"};f.repo.write("put",{kind:"put",expected_revision:0,grant:delayed});
 assert.equal(f.repo.evaluate("before_start",query()),false);f.setNow(delayed.starts_at);assert.equal(f.repo.evaluate("at_start",query()),true);
 f.providers.clock={observe:()=>({boot_id:"other_boot",continuous_ms:2000,wall_utc:delayed.starts_at})};
 assert.throws(()=>f.repo.evaluate("boot",query()),/task_grant_unverified/);
 const malformed=fixture(t);malformed.db.exec("DROP TABLE task_grant_schema;CREATE TABLE task_grant_schema(version INTEGER);INSERT INTO task_grant_schema VALUES(2)");
 assert.throws(()=>installTaskGrantSchema(malformed.db));
});
test("同時writerの再入・SQL/anchor応答喪失を成功や再送へ変換しない",t=>{
 const f=fixture(t);let nested=false;
 const second=openSecurityDatabase(f.filename);second.pragma("foreign_keys=ON");second.pragma("synchronous=FULL");t.after(()=>second.close());
 const concurrent=new TaskGrantRepository(second,f.providers,scope,f.issuer);
 const original=f.issuer.authorize;
 f.issuer.authorize=(command,mark,state)=>{if(!nested){nested=true;assert.throws(()=>concurrent.write("parallel",{kind:"put",expected_revision:0,grant:grant()}),/task_grant_unverified/);}return original(command,mark,state);};
 assert.equal(f.repo.write("winner",{kind:"put",expected_revision:0,grant:grant()}).status,"succeeded");
 assert.equal(concurrent.write("loser",{kind:"put",expected_revision:0,grant:grant()}).status,"denied");
 for(const fault of ["reserve_before","reserve_after","finalize_before","finalize_after"] as const){
  const broken=fixture(t);broken.anchors.fault=fault;
  assert.throws(()=>broken.repo.write("fault",{kind:"put",expected_revision:0,grant:grant()}),/task_grant_unverified/);
  assert.equal(broken.anchors.calls.filter(v=>v==="reserve").length,2);
 }
 const sql=fixture(t),prepare=sql.db.prepare.bind(sql.db);
 sql.db.prepare=((...args:Parameters<typeof sql.db.prepare>)=>{if(args[0].startsWith("UPDATE main.task_grant_state"))throw Error("fixture write failure");return prepare(...args);}) as typeof sql.db.prepare;
 assert.throws(()=>sql.repo.write("sql_fault",{kind:"put",expected_revision:0,grant:grant()}),/task_grant_unverified/);
 assert.deepEqual(JSON.parse(prepare("SELECT state_json FROM task_grant_state").pluck().get() as string).grants,[]);
});
test("親principal/binding失効とcurrent Epic membership driftを子へ伝播",t=>{
 const f=fixture(t);const g=grant();g.epic={repository_node_id:"repository",epic_node_id:"epic",membership_revision:1,child_issue_node_ids:["issue"]};
 f.repo.write("parent",{kind:"put",expected_revision:0,grant:g});
 const child={...g,grant_id:"child",principal:{...principal,kind:"service" as const,id:"service"},parent:{grant_id:"root",revision:1}};
 f.repo.write("child",{kind:"put",expected_revision:0,grant:child});
 const q={...query("child"),principal:child.principal,epic_membership_revision:1};assert.equal(f.repo.evaluate("ok",q),true);
 f.issuer.currentBinding=(_r,p)=>p.id!=="owner";assert.equal(f.repo.evaluate("parent_identity_revoked",q),false);
 assert.equal(f.repo.write("future_delegation",{kind:"put",expected_revision:0,grant:{...child,grant_id:"future"}}).status,"denied");
 f.issuer.currentBinding=(_r,_p,_s,e)=>e?.membership_revision===2;assert.equal(f.repo.evaluate("epic_drift",q),false);
});
test("拒否照会の自己申告principalを監査actor/revisionとして保存しない",t=>{
 const f=fixture(t);f.repo.write("put",{kind:"put",expected_revision:0,grant:grant()});
 for(const [name,q] of [["missing",query("missing")],["principal",{...query(),principal:{...principal,id:"impersonated",authz_revision:99}}],
  ["revision",{...query(),revision:99}],["resource",{...query(),resource:{...resource,issue_node_id:"other"}}]] as const){
  assert.equal(f.repo.evaluate(name,q),false);
  const record=JSON.parse(f.db.prepare("SELECT record_json FROM security_audit_records WHERE transaction_id=?").pluck().get(name) as string);
  assert.deepEqual(record.event.actor,{kind:"unauthenticated",id:null});assert.equal(record.event.authz_revision,0);assert.equal(record.event.binding_revision,0);
 }
 assert.equal(f.repo.evaluate("verified",query()),true);
 const record=JSON.parse(f.db.prepare("SELECT record_json FROM security_audit_records WHERE transaction_id='verified'").pluck().get() as string);
 assert.deepEqual(record.event.actor,{kind:"principal",id:"owner"});assert.equal(record.event.authz_revision,1);
});
test("混在IDの永続canonical orderはICU/localeCompareに依存しない",t=>{
 const f=fixture(t),original=String.prototype.localeCompare;
 String.prototype.localeCompare=function(){throw Error("locale comparator must not run");};
 try {
  for(const [i,key] of ["z","a","Z","A","a_","a-"].entries()) f.repo.write("put"+i,{kind:"put",expected_revision:0,grant:grant(key)});
  const stored=JSON.parse(f.db.prepare("SELECT state_json FROM task_grant_state").pluck().get() as string);
  assert.deepEqual(stored.grants.map((g:TaskGrant)=>g.grant_id),["A","Z","a","a-","a_","z"]);
  assert.equal(f.repo.evaluate("read",query("A")),true);
 } finally {String.prototype.localeCompare=original;}
});
