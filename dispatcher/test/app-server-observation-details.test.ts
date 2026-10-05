import assert from "node:assert/strict";
import {test} from "node:test";
import {projectItem,projectHistory,sanitizeConversationItem,sanitizeObservationText,projectNotification} from "../src/app-server/observation.js";
const turn="turn";
test("Codex160 command/MCP/dynamic契約から内容と実durationだけを投影する",()=>{
 const command=projectItem({id:"cmd",type:"commandExecution",command:"npm test",aggregatedOutput:"3 passed",status:"completed",durationMs:123,exitCode:0,reasoning:"hidden"},turn)!;
 assert.equal(command.command,"npm test");assert.equal(command.output,"3 passed");assert.equal(command.duration_ms,123);assert.equal(command.exit_code,0);assert.ok(!JSON.stringify(command).includes("hidden"));assert.ok(!("started_at" in command));
 const mcp=projectItem({id:"m",type:"mcpToolCall",server:"repo",tool:"search",arguments:{query:"project",owner_id:"private_owner",token:"private"},result:{content:[{type:"text",text:"found"},{type:"image",data:"private"}],structuredContent:{private:"hidden"}},error:{message:"not found"},durationMs:4},turn)!;
 assert.equal(mcp.tool_name,"repo.search");assert.equal(mcp.input,"query: project");assert.equal(mcp.output,"found");assert.equal(mcp.error,"not found");assert.ok(!JSON.stringify(mcp).includes("private"));
 assert.equal(projectItem({id:"d",type:"dynamicToolCall",tool:"exec",arguments:'{"command":"pwd","other":"hidden"}',contentItems:[{type:"inputText",text:"done"}]},turn)?.input,"command: pwd");
});
test("Dona依頼はobjectiveまたはSlack/Web本文だけ、envelope・result path・reasoningを含めない",()=>{
 const job='[DONA_JOB_BEGIN]\njob_json:\n'+JSON.stringify({objective:"テストを直す",result_path:"private",job_id:"private"})+'\n[DONA_JOB_END]\nsystem instruction';
 const event='[DONA_EVENT_BEGIN]\nevent_id: private\nresult_path: private\nevent_json:\n'+JSON.stringify({source:"slack",payload:{text:"進捗を確認",token:"private"}})+'\n[DONA_EVENT_END]\nsystem';
 for(const [text,expected] of [[job,"テストを直す"],[event,"進捗を確認"],["通常の依頼","通常の依頼"]])assert.equal(projectItem({id:"u",type:"userMessage",content:[{type:"text",text}]},turn)?.text,expected);
 assert.equal(projectItem({id:"u",type:"userMessage",content:[{type:"text",text:"[DONA_JOB_BEGIN]\ninvalid"}]},turn),undefined);
 assert.equal(projectItem({id:"r",type:"reasoning",text:"hidden",summary:["hidden"]},turn),undefined);
});
test("credentialとcontrol pathはsource別の全表示fieldで永続投影前に除去する",()=>{
 for(const text of ['token="private"','Authorization: Bearer private','xoxb-private','ghp_private','-----BEGIN PRIVATE KEY-----\nprivate','https://files.slack.com/private','password%3Dprivate','password\\u003dprivate'])assert.ok(!sanitizeObservationText(text).includes("private"));
 assert.ok(!sanitizeObservationText('cat /Users/alice/.dona/config/dispatcher.env').includes("dispatcher.env"));
 assert.equal(sanitizeObservationText('/Users/alice/project/src/app.ts'),'~/project/src/app.ts');
 const item=projectItem({id:"c",type:"commandExecution",command:'TOKEN="private" npm test',aggregatedOutput:'ok\npassword=private\nend'},turn)!;assert.ok(!JSON.stringify(item).includes("private"));assert.ok(item.output?.includes("ok"));
 assert.deepEqual(projectNotification("item/agentMessage/delta",{turnId:turn,itemId:"a",delta:"xoxb-"}),{kind:"item/agentMessage/delta",turn_id:turn,item_id:"a"});
});
test("projected DTO再読はkind別allowlist、bounded text/files、改変差分は行数だけ",()=>{
 const item=projectItem({id:"f",type:"fileChange",status:"completed",changes:[{path:"src/a.ts",kind:{type:"update"},diff:"--- a\n+++ b\n-old\n+new\n+more"}]},turn)!;
 assert.deepEqual(item.files,[{path:"src/a.ts",change:"update",additions:2,deletions:1}]);assert.ok(!JSON.stringify(item).includes("old"));
 const forged=sanitizeConversationItem({...item,text:"private",arguments:"private",output:"ok"})!;assert.equal(forged.text,undefined);assert.ok(!JSON.stringify(forged).includes("private"));
 assert.equal(sanitizeConversationItem({id:"a",turn_id:turn,kind:"assistant_message",text:"ok",command:"private"})?.command,undefined);
 const huge=projectItem({id:"m",type:"mcpToolCall",server:"a",tool:"b",result:{content:Array.from({length:21},()=>({type:"text",text:"x".repeat(1000)}))}},turn)!;assert.equal(huge.truncated,true);assert.ok(huge.output!.length<=8192);
 const history=projectHistory({thread:{id:"t",turns:[{id:turn,items:Array.from({length:200},(_,i)=>({id:`a${i}`,type:"commandExecution",command:"x".repeat(8192),aggregatedOutput:"y".repeat(8192)}))}]}});assert.equal(history.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(history.items))<525000);
});

test("typed detailはRuntime cacheへ安全に保存され旧cacheもread境界で再検証される",async()=>{
 const fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path"),{RuntimeStore}=await import("../src/app-server/store.js");const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-details-")),store=new RuntimeStore(path.join(root,"r.db"));
 try{const item=projectItem({id:"c",type:"commandExecution",command:"npm test",aggregatedOutput:"3 passed\ntoken=private",status:"completed"},turn)!;store.cacheItem("a","g",item);assert.deepEqual(store.cachedItems("a","g"),[item]);assert.ok(!JSON.stringify(store.db.prepare("SELECT item_json FROM observation_items").all()).includes("private"));store.db.prepare("UPDATE observation_items SET item_json=?").run(JSON.stringify({...item,command:"password=private",text:"unexpected",raw:"private"}));const cached=store.cachedItems("a","g")[0]!;assert.ok(!JSON.stringify(cached).includes("private"));assert.equal(cached.text,undefined);
 }finally{store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("複数行credentialの値とencoded保護pathを表示へ漏らさない",()=>{
 for(const text of ['{\n "api_key":\n "sensitive-placeholder"\n}', 'password=\n sensitive-placeholder', '{"token": {\n"value":"sensitive-placeholder"\n}}','{"api%5Fkey"%3A%0A"sensitive-placeholder"}'])assert.ok(!sanitizeObservationText(text).includes("sensitive-placeholder"));
 for(const text of ['/Users/alice/.codex/auth.json','/Users/alice/.dona/config/dispatcher.env','/Users/alice/.ssh/id_ed25519']){
  for(const encoded of [encodeURIComponent(text),encodeURIComponent(encodeURIComponent(text)),text.replaceAll('/',String.raw`\u002f`),text.replaceAll('/',String.raw`\/`)])assert.ok(!sanitizeObservationText(encoded).includes('alice'));
 }
 assert.equal(sanitizeObservationText('file src/module.ts\n3 passed'),'file src/module.ts\n3 passed');
});

test("provider prefixとsuffixを持つcredential識別子を単行・JSON・複数行で共通拒否する",()=>{
 for(const key of ["AWS_SECRET_ACCESS_KEY","OPENAI_API_KEY","MY_API_KEY_V2","AZURE_CLIENT_SECRET_VALUE","GOOGLE_ACCESS_TOKEN_2","DB_PASSWORD_PROD","api-key-secondary","serviceAuthorizationHeader"]){
  const secret="sensitive-placeholder";
  for(const text of [`${key}=${secret}`,JSON.stringify({[key]:secret}),`{\n "${key}":\n "${secret}"\n}`,`${key}=\n${secret}`]){
   assert.ok(!sanitizeObservationText(text).includes(secret),key);
   const projected=projectItem({id:"cmd",type:"commandExecution",command:"env",aggregatedOutput:text},turn)!;assert.ok(!JSON.stringify(projected).includes(secret),key);
  }
 }
 assert.equal(sanitizeObservationText("NODE_ENV=production\nEXIT_CODE=0"),"NODE_ENV=production\nEXIT_CODE=0");
});

test("escaped JSON credential keyを復号して値を除外する",()=>{
 for(const key of ["AWS_SECRET_ACCESS_KEY","OPENAI_API_KEY"]){
  const raw=JSON.stringify({[key]:"sensitive-placeholder"});
  for(const escaped of [raw.replaceAll('"',String.raw`\"`),JSON.stringify(raw),JSON.stringify(JSON.stringify(raw))]){
   assert.ok(!sanitizeObservationText(escaped).includes("sensitive-placeholder"));
   assert.ok(!JSON.stringify(projectItem({id:"m",type:"mcpToolCall",tool:"inspect",result:{content:[{type:"text",text:escaped}]}},turn)).includes("sensitive-placeholder"));
  }
 }
});
test("固定Codexのcollab toolは名前・状態・安全な作業内容を表示しthread metadataを出さない",()=>{
 for(const tool of ["spawnAgent","wait","sendMessage"]){const item=projectItem({id:"collab",type:"collabAgentToolCall",tool,status:"completed",prompt:"テストを確認",senderThreadId:"private-thread",receiverThreadIds:["private-thread"],agentsStates:{"private-thread":{status:"completed",message:"3 tests passed"}},reasoning:"private-reasoning"},turn)!;assert.equal(item.tool_type,"collabAgentToolCall");assert.equal(item.tool_name,tool);assert.equal(item.status,"completed");assert.equal(item.input,"テストを確認");assert.equal(item.output,"completed: 3 tests passed");assert.ok(!JSON.stringify(item).includes("private"));}
});
test("diff headerとhunk本文を区別しplus/minusで始まるコード行も数える",()=>{
 const diff="--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n+++counter;\n---counter;\n+++ userText\n--- userText\n context\ndiff --git a/next b/next\n--- a/next\n+++ b/next\n@@ -1 +1 @@\n+new\n-old";
 const item=projectItem({id:"f",type:"fileChange",changes:[{path:"src/file.ts",kind:{type:"update"},diff}]},turn)!;assert.equal(item.files?.[0]?.additions,3);assert.equal(item.files?.[0]?.deletions,3);
});

test("YAML block scalarの既知credential値も次行へ残さない",()=>{
 for(const indicator of ['|','|-','>','>+']){
  const text=`AWS_SECRET_ACCESS_KEY: ${indicator}\n  sensitive-placeholder\nnext: public`;
  assert.ok(!sanitizeObservationText(text).includes('sensitive-placeholder'));
 }
});
