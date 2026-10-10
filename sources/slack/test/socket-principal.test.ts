import assert from "node:assert/strict";
import { test } from "node:test";
import { createSocketActorVerifier, verifySocketActor } from "../src/socket-principal.js";
import { SlackWebApiClient } from "../src/slack-api.js";
const human = {id:"U_TEST",teamId:"T_TEST",stateKnown:true,isDeleted:false,isBot:false,isAppUser:false};

test("同一workspace/actorの同時受信と連続受信を共有し、期限後の停止は許可しない",async()=>{
 let time=0,calls=0,suspended=false;
 const client={getUser:async()=>{calls++;return {...human,isSuspended:suspended};}};
 const verify=createSocketActorVerifier(client,"T_TEST",()=>time);
 assert.deepEqual(await Promise.all(Array.from({length:200},()=>verify("U_TEST"))),Array(200).fill(true));
 assert.equal(calls,1); suspended=true;time=29_999;
 assert.equal(await verify("U_TEST"),true);assert.equal(calls,1);
 time=30_000;assert.equal(await verify("U_TEST"),false);assert.equal(calls,2);
 assert.equal(await createSocketActorVerifier(client,"T_OTHER",()=>time)("U_TEST"),false);
 assert.equal(await verify("U_OTHER"),false);
});
test("期限後の照会失敗で古い許可を再利用せず、再配送ですぐ回復できる",async()=>{
 let time=0,fail=false,calls=0;
 const verify=createSocketActorVerifier({getUser:async()=>{calls++;if(fail)throw Error("rate_limited");return human;}},"T_TEST",()=>time);
 assert.equal(await verify("U_TEST"),true);time=30_000;fail=true;
 assert.equal(await verify("U_TEST"),undefined);fail=false;
 assert.equal(await verify("U_TEST"),true);assert.equal(calls,3);
});
test("本人照会の期限で共有処理を解放し、遅れた成功をcacheへ入れない",async()=>{
 let signal:AbortSignal|undefined,release!:(value:typeof human)=>void;
 const verify=createSocketActorVerifier({getUser:async(_id,current)=>{signal=current;return new Promise(resolve=>{release=resolve;});}},"T_TEST");
 assert.equal(await verify("U_TEST"),undefined);assert.equal(signal?.aborted,true);
 release(human);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(await verify("U_TEST"),undefined);
});
test("users.infoのEnterprise所属とsuspendedを変換から本人確認まで評価する",async t=>{
 let suspended=false;
 t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({ok:true,user:{id:"U_TEST",team_id:"T_HOME",enterprise_user:{teams:["T_TEST"]},suspended,is_bot:false,is_app_user:false,deleted:false}}),{headers:{"content-type":"application/json"}}));
 const client=new SlackWebApiClient("fixture-token",{debug(){},info(){},warn(){},error(){}});
 assert.equal(await verifySocketActor(client,"T_TEST","U_TEST"),true);
 assert.equal(await verifySocketActor(client,"T_OUTSIDE","U_TEST"),false);
 suspended=true;assert.equal(await verifySocketActor(client,"T_TEST","U_TEST"),false);
});
