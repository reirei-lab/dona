import assert from "node:assert/strict";
import {test} from "node:test";
import {fixture,scope,content,wrapping,notification} from "./approval/fixtures/broker.js";
import {DispatcherDatabase} from "../src/database.js";
import {initializeLocalApprovalRoots} from "../src/approval/local-native.js";
import {installApprovalExecutionMarkerSchema} from "../src/approval/schema.js";
import {LocalExternalApprovalService} from "../src/approval/local-external-service.js";
import {executionKey} from "./approval/fixtures/execution.js";
import {ApprovalRecordRepository} from "../src/approval/record-repository.js";

test("Dispatcher schemaと別security connectionが同居して初期root・auth読取を保持する",async t=>{
 const f=fixture(t,false);installApprovalExecutionMarkerSchema(f.db);
 const dispatcher=new DispatcherDatabase(f.filename);t.after(()=>dispatcher.close());
 const version=f.db.pragma("user_version",{simple:true});
 initializeLocalApprovalRoots(f.db,f.providers,scope);
 assert.deepEqual(new ApprovalRecordRepository(f.db,f.providers.auditAnchors,f.providers.auditKeys,scope).readListHead({record_kind:"request",membership:"all"},1).records,[]);
 assert.equal(f.db.pragma("user_version",{simple:true}),version);
 const actor={instance_id:scope.instance_id,owner_id:"owner",device_id:"device",grant_revision:1};
 let checked=0;
 const service=new LocalExternalApprovalService(f.db,f.providers,scope,{content:()=>content,wrapping:()=>wrapping,notification:()=>notification,wrappingVersion:()=>wrapping,notificationVersion:()=>notification,execution:()=>executionKey},
  {authorize:()=>{checked++;assert.deepEqual(dispatcher.get("missing"),undefined);return true;},verifyStepUp:()=>false},
  {observe:async target=>({target,observed_at:"2026-09-19T00:00:00.000Z",bot_user_id:"U1",bot_id:"B1",workspace_name:"W",channel_name:"C",revision:{complete:true,items:[{message_ts:target.thread_ts,edited_ts:null,content_hmac_sha256:"a".repeat(64)}]}}),send:async()=>{throw Error("must not send");},reconcile:async()=>{throw Error("must not reconcile");}});
 const result=await service.request(actor,{idempotency_key:"one",workspace_id:scope.workspace_id,channel_id:"C123",thread_ts:"1791080198.497089",text:"本文"});
 assert.equal(result.status,"created");assert.ok(checked>=3);assert.equal(f.db.pragma("user_version",{simple:true}),version);
});
test("同じapproval rootの再初期化は拒否する",t=>{
 const f=fixture(t,false);installApprovalExecutionMarkerSchema(f.db);initializeLocalApprovalRoots(f.db,f.providers,scope);
 assert.throws(()=>initializeLocalApprovalRoots(f.db,f.providers,scope));
});

test("protected maintenance phaseはconfig rollbackとCAS応答喪失をfail closedにする",async()=>{
 const {LocalMaintenanceStore,encodeLocalMaintenance}=await import("../src/approval/local-maintenance.js");
 let entry={revision:1,value:encodeLocalMaintenance({codec_version:1,active_key_version:1,phase:"ready",operation_id:null,next_key_version:null,recovery_mark:null})},lost=false;
 const store=new LocalMaintenanceStore({read:()=>({...entry}),compareExchange:(expected,value)=>{assert.deepEqual(expected,entry);entry={revision:entry.revision+1,value};if(lost)throw Error("response lost");return {...entry};}});
 store.requireReady(1);const before=store.read();lost=true;
 assert.throws(()=>store.change(before,{...before.state,phase:"rotation",operation_id:"rotate",next_key_version:2,operation_config_digest:"a".repeat(64)}));
 assert.throws(()=>store.requireReady(1));assert.equal(store.read().state.phase,"rotation");lost=false;
 const current=store.read();store.change(current,{codec_version:1,active_key_version:2,phase:"ready",operation_id:null,next_key_version:null,recovery_mark:null,last_rotation:{from:1,to:2,operation_id:"rotate",config_digest:"a".repeat(64)}});
 store.requireReady(2);assert.throws(()=>store.requireReady(1));assert.equal(store.read().state.last_rotation?.from,1);
});

test("rotationは無効化完了前にreadyにせず旧configの更新前crashをread-only復旧する",async()=>{
 const {LocalMaintenanceStore,encodeLocalMaintenance}=await import("../src/approval/local-maintenance.js"),{rotateProtectedKeys}=await import("../src/approval/local-key-rotation.js");
 let entry={revision:1,value:encodeLocalMaintenance({codec_version:1,active_key_version:1,phase:"ready",operation_id:null,next_key_version:null,recovery_mark:null})};
 const store=new LocalMaintenanceStore({read:()=>({...entry}),compareExchange:(old,value)=>{assert.deepEqual(old,entry);return entry={revision:entry.revision+1,value};}});
 const trace:string[]=[];let fail=true;const ports={change:(old:ReturnType<typeof store.read>,next:Parameters<typeof store.change>[1])=>store.change(old,next),stageNewKeys:()=>{trace.push("stage");},auditAndInvalidate:()=>{trace.push("invalidate");if(fail)throw Error("fixture interrupted");},retireOldKeys:()=>{trace.push("retire");}};
 assert.throws(()=>rotateProtectedKeys(store,1,2,"a".repeat(64),ports));assert.equal(store.read().state.phase,"rotation");assert.deepEqual(trace,["stage","invalidate"]);assert.throws(()=>store.requireReady(1));
 fail=false;assert.equal(rotateProtectedKeys(store,1,2,"a".repeat(64),ports),2);assert.deepEqual(trace,["stage","invalidate","stage","invalidate","retire"]);store.requireReady(2);
 const writes=entry.revision;assert.equal(rotateProtectedKeys(store,1,2,"a".repeat(64),ports),2);assert.equal(entry.revision,writes);assert.equal(trace.length,5);
 assert.throws(()=>rotateProtectedKeys(store,1,2,"b".repeat(64),ports));assert.throws(()=>rotateProtectedKeys(store,2,4,"a".repeat(64),ports));
});
