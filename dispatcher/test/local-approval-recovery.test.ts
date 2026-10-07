import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {stripTypeScriptTypes} from "node:module";
import {pathToFileURL,fileURLToPath} from "node:url";
import Database from "better-sqlite3";

/** Native I/Oだけを隔離する。recover/provision、CAS codec、protected heads、
 * used transaction nodes、監査、clock、失効処理は同じproduction moduleを実行する。 */
async function setup(t:test.TestContext){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.homedir()),".dona-boot-recovery-"));await fs.chmod(root,0o700);t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,"package.json"),'{"type":"module"}');await fs.symlink(fileURLToPath(new URL("../node_modules",import.meta.url)),path.join(root,"node_modules"));
 const src=fileURLToPath(new URL("../src/",import.meta.url)),seen=new Set<string>();
 const copy=async(relative:string):Promise<void>=>{if(seen.has(relative))return;seen.add(relative);
  if(["approval/native-keychain-port.js","approval/native-clock.js"].includes(relative))return;
  let code=stripTypeScriptTypes(await fs.readFile(path.join(src,relative.replace(/\.js$/,".ts")),"utf8"),{mode:"transform"});
  if(relative==="approval/local-native.js")code='const process={platform:"darwin",stdin:{isTTY:true},getuid:()=>globalThis.process.getuid?.(),geteuid:()=>globalThis.process.geteuid?.()};\n'+code;
  const dest=path.join(root,"compiled",relative);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,code);
  for(const match of code.matchAll(/(?:from\s*|import\s*\()(["'])(\.[^"']+\.js)\1/g))await copy(path.normalize(path.join(path.dirname(relative),match[2]!)));
 };
 await fs.mkdir(path.join(root,"dist"));await fs.symlink(fileURLToPath(new URL("../dist/native",import.meta.url)),path.join(root,"dist/native"));await fs.symlink(src,path.join(root,"src"));
 await copy("approval/local-native.js");await copy("approval/local-external-service.js");
 await fs.writeFile(path.join(root,"compiled/approval/recovery-fixture.js"),`export const state={entries:new Map(),observation:{boot_id:'11111111-1111-1111-1111-111111111111',continuous_ms:1000,wall_utc:'2026-10-05T00:00:00.000Z'},fail:null};
 export const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);`);
 await fs.writeFile(path.join(root,"compiled/approval/native-clock.js"),`import {state} from './recovery-fixture.js';export class NativeClockSource{observe(){return {...state.observation};}}`);
 await fs.writeFile(path.join(root,"compiled/approval/native-keychain-port.js"),`import {state,canonical} from './recovery-fixture.js';export class NativeKeychainPort{
 provision(scope,value){const key=canonical(scope);if(state.entries.has(key))throw Error('fixture_existing');state.entries.set(key,{revision:1,value:Buffer.from(value).toString('base64')});}
 exchange(wire){const r=JSON.parse(wire),key=canonical(r.scope),old=state.entries.get(key);if(!old)throw Error('fixture_absent');
 if(r.operation==='read')return canonical({codec_version:1,status:'observed',...old});
 if(old.revision!==r.expected_revision||old.value!==r.expected_value)return canonical({codec_version:1,status:'conflict'});
 const next={revision:old.revision+1,value:r.proposed_value};state.entries.set(key,next);
 if(state.fail?.(r,JSON.parse(Buffer.from(next.value,'base64').toString())))throw Error('fixture_response_lost');
 return canonical({codec_version:1,status:'changed',...next});}
 close(){} }`);
 const native=await import(pathToFileURL(path.join(root,"compiled/approval/local-native.js")).href),fixture=await import(pathToFileURL(path.join(root,"compiled/approval/recovery-fixture.js")).href);
 const {LocalExternalApprovalService}=await import(pathToFileURL(path.join(root,"compiled/approval/local-external-service.js")).href);
 const file=path.join(root,"ledger.sqlite"),initial=new Database(file);await fs.chmod(file,0o600);initial.pragma("journal_mode=WAL");initial.close();
 const {openLocalApprovalDatabase}=await import(pathToFileURL(path.join(root,"compiled/approval/local-database.js")).href);const db=openLocalApprovalDatabase(file);t.after(()=>db.close());
 const config={codec_version:1,scope:{instance_id:"instance",workspace_id:"workspace"},owner_id:"owner",ledger_id:"ledger",access_group:"ABCDEFGHIJ.dona",used_nodes_database:path.join(root,"nodes.sqlite"),slack_workspace_alias:"fixture",key_version:1};
 native.provisionNativeLocalApproval(db,config,"instance/workspace/owner");
 const connect=()=>new native.NativeLocalApprovalConnection(db,config);
 const connection=connect();let sends=0;
 const makeService=(connection:any)=>new LocalExternalApprovalService(db,connection.providers,config.scope,connection.keys,{authorize:()=>true,verifyStepUp:()=>true},{observe:async(target:any)=>({target,observed_at:fixture.state.observation.wall_utc,bot_user_id:"U1",bot_id:"B1",workspace_name:"W",channel_name:"C",revision:{complete:true,items:[{message_ts:target.thread_ts,edited_ts:null,content_hmac_sha256:"a".repeat(64)}]}}),send:async()=>{sends++;return {outcome:"accepted",receipt_ref:"unexpected"};},reconcile:async()=>({outcome:"unknown"})});
 const service=makeService(connection);
 const actor={instance_id:"instance",owner_id:"owner",device_id:"device",grant_revision:1};
 const request=await service.request(actor,{idempotency_key:"pending",workspace_id:"workspace",channel_id:"C1",thread_ts:"1791080198.497089",text:"旧pending本文"});assert.equal(request.status,"created");
 const before=service.status(actor,request.request_handle);connection.close();
 const boot=()=>{fixture.state.observation={boot_id:"22222222-2222-2222-2222-222222222222",continuous_ms:50,wall_utc:"2026-10-05T00:01:00.000Z"};};
 const recover=()=>native.recoverNativeLocalApproval(db,config,"instance/workspace/owner:recover");
 const maintenance=()=>{const row=[...fixture.state.entries.entries()].find(([k]:any)=>JSON.parse(k).purpose==="policy_generation") as any;return JSON.parse(Buffer.from(row[1].value,"base64").toString());};
 return {db,native,config,fixture,connect,makeService,actor,boot,recover,maintenance,before,id:request.request_handle,sends:()=>sends};
}

test("boot変更の実recoverは旧pendingを失効しprotected clock前進後だけreadyへ戻す",async t=>{
 const f=await setup(t);assert.throws(f.recover,/not_required/);f.boot();
 const stale=f.connect();assert.equal(stale.doctor().ready,false);stale.close();
 f.recover();assert.equal(f.maintenance().phase,"ready");
 const fresh=f.connect();try{assert.equal(fresh.doctor().ready,true);assert.equal(fresh.providers.clockMarks.read().boot_id,f.fixture.state.observation.boot_id);
 assert.ok(fresh.providers.clockMarks.read().effective_utc>=f.fixture.state.observation.wall_utc);
 const service=f.makeService(fresh);await service.executePending();assert.equal(f.sends(),0);
 const next=await service.request(f.actor,{idempotency_key:"after_recovery",workspace_id:"workspace",channel_id:"C1",thread_ts:"1791080198.497089",text:"復旧後の新しい依頼"});assert.equal(next.status,"created");assert.notEqual(next.request_handle,f.id);
 }finally{fresh.close();}
 const request=f.db.prepare("SELECT state,expires_at FROM approval_requests WHERE request_id=?").get(f.id) as any;
 assert.equal(request.state,"needs_review");assert.equal(request.expires_at,f.before.expires_at);assert.equal(f.db.prepare("SELECT state FROM approval_payload_metadata WHERE owner_id=?").pluck().get(f.id),"deleted");assert.equal(f.sends(),0);
 assert.throws(f.recover,/not_required/);
});
for(const point of ["phase","clock","ready"] as const)test(`${point} CAS応答喪失から同じrecoverを再開し旧要求を復活させない`,async t=>{
 const f=await setup(t);f.boot();let fired=false;
 f.fixture.state.fail=(request:any,value:any)=>{const match=point==="phase"?request.scope.purpose==="policy_generation"&&value.phase==="boot_recovery":point==="clock"?request.scope.purpose==="clock_mark"&&value.state.boot_id===f.fixture.state.observation.boot_id:request.scope.purpose==="policy_generation"&&value.phase==="ready";
 if(!fired&&match){fired=true;return true;}return false;};
 assert.throws(f.recover);assert.equal(fired,true);f.fixture.state.fail=null;
 if(point!=="ready"){assert.equal(f.maintenance().phase,"boot_recovery");assert.throws(f.connect);f.recover();}else assert.throws(f.recover,/not_required/);
 assert.equal(f.maintenance().phase,"ready");const c=f.connect();try{assert.equal(c.doctor().ready,true);}finally{c.close();}
 assert.equal(f.db.prepare("SELECT state FROM approval_requests WHERE request_id=?").pluck().get(f.id),"needs_review");assert.equal(f.sends(),0);
});
