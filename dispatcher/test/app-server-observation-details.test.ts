import assert from "node:assert/strict";
import {test} from "node:test";
import {projectItem,projectHistory,sanitizeConversationItem,sanitizeObservationText,projectNotification} from "../src/app-server/observation.js";
const turn="turn";
test("diff headerとhunk本文を区別しplus/minusで始まるコード行も数える",()=>{
 const diff="--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n+++counter;\n---counter;\n+++ userText\n--- userText\n context\ndiff --git a/next b/next\n--- a/next\n+++ b/next\n@@ -1 +1 @@\n+new\n-old";
 const item=projectItem({id:"f",type:"fileChange",changes:[{path:"src/file.ts",kind:{type:"update"},diff}]},turn)!;assert.equal(item.files?.[0]?.additions,3);assert.equal(item.files?.[0]?.deletions,3);
});
test("Codex Add/Deleteのraw contentはprefixによらずファイル行数を数える",()=>{
 // rust-v0.160.0 thread_history.rs: FileChange::Add(content="hello\\n") → FileUpdateChange(diff="hello\\n")。
 for(const kind of ["add","delete"]){for(const [diff,lines] of [["hello\n",1],["hello\nworld",2],["+++counter\n---counter\n",2],["\n",1],["",0],["hello\r\nworld\r\n",2]] as const){
  const file=projectItem({id:"file",type:"fileChange",changes:[{path:"src/file.ts",kind:{type:kind},diff}]},turn)?.files?.[0];assert.equal(file?.additions,kind==="add"?lines:0);assert.equal(file?.deletions,kind==="delete"?lines:0);
 }}
});
test("履歴は最新200投影で止まり古いturnやitemのpayloadに触れず時系列へ戻す",()=>{
 const old={get id():string{throw Error("old turn projected");}};
 const newest=Array.from({length:200},(_,i)=>({id:`i${i}`,type:"agentMessage",text:String(i)}));
 const result=projectHistory({thread:{id:"thread",turns:[old,{id:turn,items:newest}]}});
 assert.equal(result.items.length,200);assert.equal(result.items[0]?.text,"0");assert.equal(result.items.at(-1)?.text,"199");assert.equal(result.truncated,true);
});
test("固定Codex imageGenerationはbegin/terminal/failureの状態だけを表示する",()=>{
 for(const [status,failure,expected] of [["",null,"inProgress"],["completed",null,"completed"],["failed",null,"failed"],["completed",{type:"usageLimitExceeded",limitId:"private",resetsAt:123},"failed"]] as const){
  const item=projectItem({id:"image",type:"imageGeneration",status,failure,result:"private-image-bytes",savedPath:"/private/image.png",revisedPrompt:"private prompt"},turn)!;
  assert.deepEqual(item,{id:"image",turn_id:turn,kind:"tool_progress",tool_type:"imageGeneration",status:expected});
  assert.ok(!JSON.stringify(sanitizeConversationItem({...item,output:"private-image-bytes",files:[{path:"/private/image.png",change:"add"}]})).includes("private"));
 }
});
test("既知control itemは実metadataだけを投影しraw本文・image・thread/pathを出さない",()=>{
 for(const type of ["sleep","contextCompaction","enteredReviewMode","exitedReviewMode","subAgentActivity","functionCallOutput"]){
  const item=projectItem({id:"control",type,status:"completed",durationMs:25,name:"exec_command",output:"password=private-output",review:"private-review",agentThreadId:"private-thread",agentPath:"private-path",result:"private-image",text:"private-text"},turn)!;
  assert.equal(item.tool_type,type);assert.equal(item.kind,"tool_progress");assert.equal(item.status,undefined);if(type==="functionCallOutput")assert.equal(item.output,"password=private-output");else assert.ok(!JSON.stringify(item).includes("private"));
  assert.equal(item.duration_ms,type==="sleep"?25:undefined);assert.equal(item.tool_name,type==="functionCallOutput"?"exec_command":undefined);
 }
 for(const type of ["plan","hookPrompt","reasoning"])assert.equal(projectItem({id:"hidden",type,text:"private",summary:["private"]},turn),undefined);
});
test("fileChange update移動先と本文はcache再読でもそのまま保持する",async()=>{
 const changes=[{path:"src/old.ts",kind:{type:"update",move_path:"src/new.ts"},diff:"@@ -1 +1 @@\n-old\n+new"},{path:"src/no-diff.ts",kind:{type:"update",move_path:"src/moved.ts"}},{path:"src/huge.ts",kind:{type:"update",move_path:"src/moved-huge.ts"},diff:"x".repeat(131073)},{path:"src/null.ts",kind:{type:"update",move_path:null},diff:""},{path:"src/add.ts",kind:{type:"add",move_path:"unexpected"},diff:"new"}];
 const item=projectItem({id:"moves",type:"fileChange",changes},turn)!;
 assert.deepEqual(item.files?.[0],{path:"src/old.ts",change:"update",move_path:"src/new.ts",additions:1,deletions:1,diff:changes[0]!.diff});
 assert.equal(item.files?.[1]?.move_path,"src/moved.ts");assert.equal(item.files?.[2]?.move_path,"src/moved-huge.ts");assert.equal(item.files?.[3]?.move_path,undefined);assert.equal(item.files?.[4]?.move_path,undefined);
 const privateItem=projectItem({id:"private_move",type:"fileChange",changes:[{path:"src/a",kind:{type:"update",move_path:"/Users/alice/.codex/auth.json"},diff:""}]},turn)!;
 assert.equal(privateItem.files?.[0]?.move_path,"/Users/alice/.codex/auth.json");
 const bounded=sanitizeConversationItem({...item,files:[{path:"src/a",change:"update",move_path:"x".repeat(1025)}]})!;assert.equal(bounded.files?.[0]?.move_path?.length,1025);assert.equal(bounded.truncated,undefined);
 const fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path"),{RuntimeStore}=await import("../src/app-server/store.js");const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-details-move-")),store=new RuntimeStore(path.join(root,"r.db"));
 try{
  store.cacheItem("a","g",item);assert.deepEqual(store.cachedItems("a","g"),[item]);
  store.db.prepare("UPDATE observation_items SET item_json=?").run(JSON.stringify({...item,files:[{path:"src/a",change:"update",move_path:"/Users/alice/.codex/auth.json",raw:"hidden"}]}));
  const cached=store.cachedItems("a","g")[0]!;assert.ok(cached.files?.[0]?.move_path);assert.equal(cached.files?.[0]?.move_path,"/Users/alice/.codex/auth.json");assert.ok(!JSON.stringify(cached).includes("hidden"));
 }finally{store.close();await fs.rm(root,{recursive:true,force:true});}
});
test("file pathは長さによって省略しない",()=>{
 for(const length of [1023,1024,1025]){
  const item=projectItem({id:"path",type:"fileChange",changes:[{path:"x".repeat(length),kind:{type:"update"},diff:""}]},turn)!;
  assert.equal(item.files?.[0]?.path.length,length);assert.equal(item.truncated,undefined);
  assert.deepEqual(sanitizeConversationItem(item),item);
 }
 const cached=sanitizeConversationItem({id:"old",turn_id:turn,kind:"tool_progress",tool_type:"fileChange",files:[{path:"x".repeat(1025),change:"add"}]})!;
 assert.equal(cached.truncated,undefined);assert.equal(cached.files?.[0]?.path.length,1025);
});
test("App Serverの通知msと履歴秒を区別し日時と出典を投影する",()=>{
 const ms=Date.parse('2026-10-06T01:02:03.456Z');
 assert.equal(projectNotification('item/started',{turnId:turn,item:{id:'u'},startedAtMs:ms})?.occurred_at,'2026-10-06T01:02:03.456Z');
 assert.equal(projectNotification('item/completed',{turnId:turn,item:{id:'u'},completedAtMs:ms+1000})?.occurred_at,'2026-10-06T01:02:04.456Z');
 for(const bad of [undefined,null,'2026-10-06',-1,Infinity,NaN,1e20])assert.equal(projectNotification('item/started',{startedAtMs:bad})?.occurred_at,undefined);
 const result=projectHistory({thread:{id:'thread',turns:[{id:turn,startedAt:Math.floor(ms/1000),completedAt:Math.floor(ms/1000)+10,items:[{id:'u',type:'userMessage',content:[{type:'text',text:'確認'}]}]}]}});
 const item=sanitizeConversationItem(result.items[0])!;
 assert.equal(item.turn_started_at,'2026-10-06T01:02:03.000Z');assert.equal(item.turn_completed_at,'2026-10-06T01:02:13.000Z');
 assert.equal(sanitizeConversationItem({...item,turn_started_at:'secret',turn_completed_at:'2026-02-30T01:02:03.000Z'})?.turn_started_at,undefined);
 assert.equal(sanitizeConversationItem({...item,turn_completed_at:'2026-02-30T01:02:03.000Z'})?.turn_completed_at,undefined);
});
 test("大きな差分と多数ファイルをApp Serverからcacheまで無改変で保持する",async()=>{
 const diff='const password = "example-only";\n'+'x'.repeat(600000)+'\n'.repeat(600);
 const changes=Array.from({length:21},(_,i)=>({path:i===0?'.env':`src/${i}.ts`,kind:{type:'add'},diff:i===0?diff:'hello\n'}));
 const history=projectHistory({thread:{id:'t',turns:[{id:'turn',items:[{id:'f',type:'fileChange',changes}]}]}});
 assert.equal(history.truncated,false);assert.equal(history.items[0]?.files?.length,21);assert.equal(history.items[0]?.files?.[0]?.diff,diff);
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),{RuntimeStore}=await import('../src/app-server/store.js');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dona-full-diff-')),store=new RuntimeStore(path.join(root,'r.db'));
 try{store.cacheItem('a','g',history.items[0]!);assert.deepEqual(store.cachedItems('a','g'),history.items);}finally{store.close();await fs.rm(root,{recursive:true,force:true});}
 });

test("コマンド・実行結果・エラー・メッセージは端末認証後に原文を保持する",()=>{
 const samples=['/Users/alice/.dona/workspaces/task/file.ts','Authorization: Bearer example-only','password=example-only','TOKEN=example-only','-----BEGIN PRIVATE KEY-----\nexample-only','https://user:example-only@example.com','<script>example-only</script>',String.raw`password%3Dexample-only`, '[認証optionを含む内容を省略]', 'x'.repeat(140000)];
 for(const text of samples){
  assert.equal(sanitizeObservationText(text),text);
  const command=projectItem({id:'c',type:'commandExecution',command:text,aggregatedOutput:text},turn)!;
  assert.equal(command.command,text);assert.equal(command.output,text);assert.equal(command.truncated,undefined);
  assert.equal(sanitizeConversationItem({...command,error:text})?.error,text);
  assert.equal(projectItem({id:'a',type:'agentMessage',text},turn)?.text,text);
  assert.equal(projectItem({id:'u',type:'userMessage',content:[{type:'text',text}]},turn)?.text,text);
 }
});
test("MCP引数・構造化結果・function outputのテキストを省略しない",()=>{
 const args={command:'cat /Users/alice/.dona/file',token:'example-only',other:'data'};
 const output=Array.from({length:25},(_,i)=>({type:'text',text:`line ${i} password=example-only`}));
 const mcp=projectItem({id:'m',type:'mcpToolCall',server:'repo',tool:'read',arguments:args,result:{content:output,structuredContent:args}},turn)!;
 assert.equal(mcp.input,JSON.stringify(args));assert.equal(mcp.output,output.map(x=>x.text).join('\n')+'\n'+JSON.stringify(args));
 const text='TOKEN=example-only\n'+'x'.repeat(150000);
 const fn=projectItem({id:'f',type:'functionCallOutput',output:[{type:'input_text',text}]},turn)!;assert.equal(fn.output,text);assert.equal(fn.truncated,undefined);
});
test("長い本文が保存・再読・履歴投影で伏字や切り詰めにならない",async()=>{
 const text='password=example-only\n/Users/alice/.dona/path\n'+'x'.repeat(2200000);
 const item=projectItem({id:'c',type:'commandExecution',command:'rg file /Users/alice/.dona/path',aggregatedOutput:text},turn)!;
 const history=projectHistory({thread:{id:'t',turns:[{id:turn,items:[{id:'c',type:'commandExecution',aggregatedOutput:text}]}]}});assert.equal(history.items[0]?.output,text);assert.equal(history.truncated,false);
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),{RuntimeStore}=await import('../src/app-server/store.js');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dona-raw-text-')),store=new RuntimeStore(path.join(root,'r.db'));
 try{store.cacheItem('a','g',item);assert.deepEqual(store.cachedItems('a','g'),[item]);const forged=sanitizeConversationItem({...item,raw:'not-a-display-field'});assert.ok(!JSON.stringify(forged).includes('not-a-display-field'));}finally{store.close();await fs.rm(root,{recursive:true,force:true});}
});
