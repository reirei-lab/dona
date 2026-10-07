import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackWebApiClient } from "../src/slack-api.js";
const logger={debug(){},info(){},warn(){},error(){}};
for(const method of ["user","channel","members"] as const)test(`status ${method} read cancels underlying fetch and pagination`,async t=>{
 let calls=0,active=0;const controller=new AbortController();
 t.mock.method(globalThis,"fetch",async(_url:unknown,init?:RequestInit)=>{
  calls++;
  if(method==="members"&&calls===1)return new Response(JSON.stringify({ok:true,members:[],response_metadata:{next_cursor:"next"}}),{headers:{"content-type":"application/json"}});
  active++;const signal=init!.signal!;
  return new Promise<Response>((_resolve,reject)=>{
   const abort=()=>{active--;reject(signal.reason);};
   if(signal.aborted)abort();else signal.addEventListener("abort",abort,{once:true});
   setTimeout(()=>controller.abort(new Error("status deadline")),25);
  });
 });
 const client=new SlackWebApiClient("fixture-token",logger);
 await assert.rejects(method==="user"?client.getUser("U_TEST",controller.signal):method==="channel"?client.getChannel("C_TEST",controller.signal):client.hasChannelMember("C_TEST","U_TEST",controller.signal));
 assert.equal(active,0);assert.equal(calls,method==="members"?2:1);
 await assert.rejects(client.getUser("U_TEST",controller.signal));assert.equal(calls,method==="members"?2:1);
});
