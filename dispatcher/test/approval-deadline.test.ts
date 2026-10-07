import assert from "node:assert/strict";
import {test} from "node:test";
import {approvalDeadline} from "../src/approval/deadline.js";

test("deadline後のauthority読取結果は採用せず後続読取も開始しない",async()=>{
 const controller=new AbortController();let release!:(value:string)=>void,second=0;
 const read=new Promise<string>(resolve=>{release=resolve;});
 const pending=(async()=>{await approvalDeadline(()=>read,controller.signal);await approvalDeadline(()=>{second++;return "second";},controller.signal);})();
 await Promise.resolve();controller.abort(Error("expired"));await assert.rejects(pending,/expired/);
 release("late");await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(second,0);
});
test("完了・同期失敗・既にabort済みを区別しlistenerを解放する",async t=>{
 const controller=new AbortController(),remove=t.mock.method(controller.signal,"removeEventListener");
 assert.equal(await approvalDeadline(()=>"ready",controller.signal),"ready");assert.equal(remove.mock.callCount(),1);
 await assert.rejects(approvalDeadline(()=>{throw Error("read_failed");},controller.signal),/read_failed/);assert.equal(remove.mock.callCount(),2);
 controller.abort(Error("expired"));let called=false;assert.throws(()=>approvalDeadline(()=>{called=true;return "bad";},controller.signal),/expired/);assert.equal(called,false);
});
