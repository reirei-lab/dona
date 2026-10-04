#!/usr/bin/env node
import path from "node:path";
import {loadConfig} from "../config.js";
import {serveRuntime} from "./host.js";
import {RuntimeClient} from "./client.js";
import {runtimeSocket} from "./adapters.js";

// 開発launcher専用。既存hostには接続せず、host所有権を取得できた場合だけ起動する。
const config=loadConfig(),root=path.resolve(import.meta.dirname,"../../.."),socket=runtimeSocket(config);
const server=await serveRuntime({socket,database:path.join(path.dirname(socket),"runtime.sqlite3"),codex:config.codexPath,buildSha:config.buildSha});
const client=new RuntimeClient(socket,95_000);
let stopping=false;
async function stop(code:number):Promise<void>{
 if(stopping)return;stopping=true;
 try {
  for(const agent of await client.list())if(agent.state!=="stopped")await client.stop(agent.name,agent.generation);
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  process.exit(code);
 }catch{console.error("[runtime] 停止を確認できないagentがあります。runtime DBを保持しました。");process.exit(1);}
}
for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{void stop(signal==="SIGINT"?130:143);});
try {
 const args=["-c",`projects = { ${JSON.stringify(root)} = { trust_level = "trusted" } }`,"-c","features.default_mode_request_user_input=false","-c",'model_reasoning_effort="low"'];
 for(const [name,directory] of [["dona_dispatcher","dispatcher"],["dona_slack","sources/slack"]]) {
  for(const [key,value] of Object.entries({command:process.execPath,args:[path.join(root,directory!,"dist/mcp/index.js")],cwd:path.join(root,directory!),enabled:true,required:true}))args.push("-c",`mcp_servers.${name}.${key}=${JSON.stringify(value)}`);
 }
 await client.start({name:config.agentName,role:"main",cwd:root,release:root,args,threadConfig:{model:"gpt-6.1-sol",approvalsReviewer:"auto_review",developerInstructions:"Dona mainとしてAGENTS.mdに従う。ユーザーへの質問はSlack MCPを使い、native request_user_inputは使わない。"}});
 console.log("[runtime] App Serverとdona-mainがreadyになりました");
}catch(error){console.error("[runtime] 起動できませんでした",error instanceof Error?error.message:String(error));await stop(1);}
