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
test("users.infoのEnterprise所属と任意のsuspendedの省略・false・trueを評価する",async t=>{
 let suspended:boolean|undefined;
 t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({ok:true,user:{id:"U_TEST",team_id:"T_HOME",enterprise_user:{teams:["T_TEST"]},suspended,is_bot:false,is_app_user:false,deleted:false}}),{headers:{"content-type":"application/json"}}));
 const client=new SlackWebApiClient("fixture-token",{debug(){},info(){},warn(){},error(){}});
 assert.equal((await client.getUser("U_TEST")).isSuspended,undefined);
 assert.equal(await verifySocketActor(client,"T_TEST","U_TEST"),true);
 suspended=false;assert.equal(await verifySocketActor(client,"T_TEST","U_TEST"),true);
 assert.equal(await verifySocketActor(client,"T_OUTSIDE","U_TEST"),false);
 suspended=true;assert.equal(await verifySocketActor(client,"T_TEST","U_TEST"),false);
});

test("異なる200人とその再配送でもworkspaceのrolling minute上限を超えない",async()=>{
 let time=0,calls=0;
 const verify=createSocketActorVerifier({getUser:async id=>{calls++;return {...human,id};}},"T_TEST",()=>time);
 const actors=Array.from({length:200},(_,i)=>"U_"+i);
 const first=await Promise.all(actors.map(id=>verify(id)));
 assert.equal(first.filter(x=>x===true).length,60);assert.equal(calls,60);
 await Promise.all(actors.map(id=>verify(id)));assert.equal(calls,60);
 time=59_999;assert.equal(await verify("U_199"),undefined);assert.equal(calls,60);
 time=60_000;assert.equal(await verify("U_199"),true);assert.equal(calls,61);
});
test("SlackのRetry-Afterをworkspaceで共有し、再配送からの再照会も待機させる",async()=>{
 let time=0,calls=0;
 const verify=createSocketActorVerifier({getUser:async id=>{calls++;if(calls===1)throw {errorCode:"rate_limited",retryAfterSeconds:120};return {...human,id};}},"T_TEST",()=>time);
 assert.equal(await verify("U_TEST"),undefined);
 time=119_999;assert.equal(await verify("U_OTHER"),undefined);assert.equal(calls,1);
 time=120_000;assert.equal(await verify("U_OTHER"),true);assert.equal(calls,2);
});
