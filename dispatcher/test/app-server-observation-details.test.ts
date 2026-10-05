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
 const item=projectItem({id:"c",type:"commandExecution",command:'TOKEN="private" npm test',aggregatedOutput:'ok\npassword=private\nend'},turn)!;assert.ok(!JSON.stringify(item).includes("private"));assert.equal(item.command,"[認証optionを含む内容を省略]");assert.equal(item.output,item.command);assert.equal(sanitizeConversationItem({...item,error:"private"})?.error,item.command);
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

test("known credential assignmentのfield全体をYAML comment/tag/anchorやscalar構文によらず省略する",()=>{
 for(const value of ["| # confidential","!!str |","&credential |",">- # folded","# comment","!!str &credential |2-"]){
  const text=`normal preceding output\nOPENAI_API_KEY: ${value}\n  sensitive-placeholder\nnormal following output`;
  assert.equal(sanitizeObservationText(text),"[機密情報を含む内容を省略]");
  assert.equal(projectItem({id:"tool",type:"commandExecution",aggregatedOutput:text},turn)?.output,"[機密情報を含む内容を省略]");
 }
 assert.equal(sanitizeObservationText("normal output\n3 tests passed"),"normal output\n3 tests passed");
});
test("schemeに依存せず接続URIのuserinfoを保存前に伏せる",()=>{
 for(const scheme of ["postgres","postgresql","mysql","mongodb","mongodb+srv","redis","rediss","amqp","amqps","ftp","ssh","custom-v1.2"]){
  for(const uri of [`${scheme}://alice:sensitive-placeholder@db.internal/app`,`${scheme}://alice%3Asensitive-placeholder%40db.internal/app`,...["%2F","%20","%09","%0A","%3F","%23","%40","%252F"].map(encoded=>`${scheme}://alice:sensitive-placeholder${encoded}tail@db.internal/app`)]){
   const text=`接続先\nDATABASE_URL=${uri}\n正常な出力`;
   assert.equal(sanitizeObservationText(text),"接続先\n[機密情報を含む行を省略]\n正常な出力");
   for(const item of [projectItem({id:"command",type:"commandExecution",aggregatedOutput:text},turn),projectItem({id:"request",type:"userMessage",content:[{type:"text",text}]},turn)])assert.ok(!JSON.stringify(item).includes("sensitive-placeholder"));
  }
 }
 assert.equal(sanitizeObservationText("postgres://db.internal/app"),"postgres://db.internal/app");
 for(const uri of [String.raw`postgres:\/\/alice:p%2Fss@db.internal/app`,String.raw`postgres:\u002f\u002falice:p%20ss@db.internal/app`])assert.equal(sanitizeObservationText(uri),"[機密情報を含む行を省略]");
});
test("Codex Add/Deleteのraw contentはprefixによらずファイル行数を数える",()=>{
 // rust-v0.160.0 thread_history.rs: FileChange::Add(content="hello\\n") → FileUpdateChange(diff="hello\\n")。
 for(const kind of ["add","delete"]){for(const [diff,lines] of [["hello\n",1],["hello\nworld",2],["+++counter\n---counter\n",2],["\n",1],["",0],["hello\r\nworld\r\n",2]] as const){
  const file=projectItem({id:"file",type:"fileChange",changes:[{path:"src/file.ts",kind:{type:kind},diff}]},turn)?.files?.[0];assert.equal(file?.additions,kind==="add"?lines:0);assert.equal(file?.deletions,kind==="delete"?lines:0);
 }}
});

test("多重JSON内のUnicode credential keyはbackslashを残さず検査する",()=>{
 for(const key of [String.raw`TOK\u0045N`,String.raw`OPENAI_API_K\u0045Y`,String.raw`AWS_S\u0045CRET_ACCESS_KEY`]){
  let text=`{"${key}":"sensitive-placeholder"}`;
  for(let depth=0;depth<7;depth++){
   assert.ok(!sanitizeObservationText(text).includes("sensitive-placeholder"),`depth ${depth}`);
   assert.ok(!JSON.stringify(projectItem({id:"m",type:"mcpToolCall",tool:"inspect",result:{content:[{type:"text",text}]}},turn)).includes("sensitive-placeholder"));
   text=JSON.stringify(text);
  }
 }
 for(const key of [String.raw`TOK\u005cu0045N`,String.raw`TOK\\\\u0045N`,String.raw`TOK%5C%5Cu0045N`])assert.ok(!sanitizeObservationText(`${key}=sensitive-placeholder`).includes("sensitive-placeholder"));
 assert.equal(sanitizeObservationText(String.raw`普通のUnicode表示 \u65e5`),String.raw`普通のUnicode表示 \u65e5`);
});
test("履歴は最新200投影で止まり古いturnやitemのpayloadに触れず時系列へ戻す",()=>{
 const old={get id():string{throw Error("old turn projected");}};
 const newest=Array.from({length:200},(_,i)=>({id:`i${i}`,type:"agentMessage",text:String(i)}));
 const result=projectHistory({thread:{id:"thread",turns:[old,{id:turn,items:newest}]}});
 assert.equal(result.items.length,200);assert.equal(result.items[0]?.text,"0");assert.equal(result.items.at(-1)?.text,"199");assert.equal(result.truncated,true);
});
test("履歴byte上限到達後は古い高負荷itemを投影しない",()=>{
 let inspected=0;const items=Array.from({length:200},(_,i)=>({id:`i${i}`,type:"agentMessage",get text(){inspected++;if(i<130)throw Error("old payload projected");return "x".repeat(8192);}}));
 const result=projectHistory({thread:{id:"thread",turns:[{id:turn,items}]}});
 assert.equal(result.truncated,true);assert.ok(result.items.length<70);assert.ok(inspected<210);assert.equal(result.items.at(-1)?.id,"i199");assert.ok(Buffer.byteLength(JSON.stringify(result.items))<525000);
});

test("URI userinfoはJSON/percent各層の区切り変化前に検査する",()=>{
 for(const separator of ["%2F","%20","%09","%0A","%3F","%23","%40","%252F"]){
  const uri=`postgres://alice:sensitive-placeholder${separator}tail@db.internal/app`;
  const wrapped=[encodeURIComponent(uri),JSON.stringify(encodeURIComponent(uri)),encodeURIComponent(JSON.stringify(uri)),encodeURIComponent(String.raw`postgres:\/\/alice:sensitive-placeholder${separator}tail@db.internal/app`),encodeURIComponent(String.raw`postgres:\u002f\u002falice:sensitive-placeholder${separator}tail@db.internal/app`)];
  for(let text of wrapped){for(let depth=0;depth<3;depth++){
   assert.equal(sanitizeObservationText(text),"[機密情報を含む行を省略]");
   assert.ok(!JSON.stringify(projectItem({id:"m",type:"mcpToolCall",tool:"query",result:{content:[{type:"text",text}]}},turn)).includes("sensitive-placeholder"));
   text=depth%2===0?JSON.stringify(text):encodeURIComponent(text);
  }}
 }
 const publicUri=encodeURIComponent('postgres://db.internal/app');assert.equal(sanitizeObservationText(publicUri),publicUri);
});

test("既知password別名のassignmentを省略しauthor等の通常fieldは保持する",()=>{
 for(const key of ["MYSQL_PWD","REDISCLI_AUTH","NPM_CONFIG__AUTH","_auth","SSHPASS","AUTH","passwd","DB_PASSWD","PG_PASSPHRASE","service_pwd"]){
  for(const text of [`${key}=sensitive-placeholder`,JSON.stringify({[key]:"sensitive-placeholder"}),`${key}: | # value\n  sensitive-placeholder`])assert.ok(!sanitizeObservationText(text).includes("sensitive-placeholder"));
 }
 assert.equal(sanitizeObservationText('author="alice"\nAUTHORS=3'),'author="alice"\nAUTHORS=3');
});
test("既知CLIの認証optionはshort/cluster/long/JSON形式を保守的に省略する",()=>{
 const commands=[
  ...["-u alice:sensitive-placeholder","-ualice:sensitive-placeholder","-sSualice:sensitive-placeholder","-Ualice:sensitive-placeholder","-H X-Custom:sensitive-placeholder","-b session=sensitive-placeholder","-E cert.pem:sensitive-placeholder","-x alice:sensitive-placeholder@proxy","--user=alice:sensitive-placeholder","--proxy-user alice:sensitive-placeholder","--oauth2-bearer sensitive-placeholder","--proxy-header X-Custom:sensitive-placeholder","--cookie session=sensitive-placeholder","--cert cert.pem:sensitive-placeholder","--pass sensitive-placeholder","--proxy alice:sensitive-placeholder@proxy","--proxy-cert cert.pem:sensitive-placeholder","--proxy-pass sensitive-placeholder","--tlspassword sensitive-placeholder","--proxy-tlspassword sensitive-placeholder"].map(flags=>`curl ${flags} https://example.com`),
  "mysql -psensitive-placeholder","mysql --password=sensitive-placeholder","mysql -vvpsensitive-placeholder","redis-cli -a sensitive-placeholder PING","redis-cli --pass=sensitive-placeholder PING","redis-cli AUTH sensitive-placeholder","sshpass -p sensitive-placeholder ssh host",
 ];
 for(const command of commands)for(const text of [command,JSON.stringify({command}),encodeURIComponent(command)]){
  assert.ok(!sanitizeObservationText(text).includes("sensitive-placeholder"),command);
  assert.ok(!JSON.stringify(projectItem({id:"cmd",type:"commandExecution",command:text,aggregatedOutput:text},turn)).includes("sensitive-placeholder"),command);
 }
 for(const command of ["npm test","git diff --stat","curl -sS https://example.com","curl -XGET https://example.com","mysql --version","redis-cli -p 6379 PING"])assert.equal(sanitizeObservationText(command),command);
});

test("Kubernetes client-key-dataとclient-keyはcredential assignmentとして省略する",()=>{
 for(const key of ["client-key-data","client_key_data","client-key"]){for(const text of [`${key}: c2Vuc2l0aXZlLXBsYWNlaG9sZGVy`,JSON.stringify({[key]:"c2Vuc2l0aXZlLXBsYWNlaG9sZGVy"}),`${key}: | # base64\n  c2Vuc2l0aXZlLXBsYWNlaG9sZGVy`]){
  assert.equal(sanitizeObservationText(text),"[機密情報を含む内容を省略]");assert.ok(!JSON.stringify(projectItem({id:"c",type:"commandExecution",aggregatedOutput:text},turn)).includes("c2Vuc2l0aXZl"));
 }}
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
  assert.equal(item.tool_type,type);assert.equal(item.kind,"tool_progress");assert.equal(item.status,undefined);assert.ok(!JSON.stringify(item).includes("private"));
  assert.equal(item.duration_ms,type==="sleep"?25:undefined);assert.equal(item.tool_name,type==="functionCallOutput"?"exec_command":undefined);
 }
 for(const type of ["plan","hookPrompt","reasoning"])assert.equal(projectItem({id:"hidden",type,text:"private",summary:["private"]},turn),undefined);
});

test("netrcの空白区切りcredentialをsingle/multiline/quoted/continuationで省略する",()=>{
 const snippets=[
  "machine api.example login alice password sensitive-placeholder",
  'machine "api.example" login "alice" password "sensitive-placeholder"',
  'machine "api.example" login sensitive-placeholder',
  'machine api.example\n login "alice"\n password "sensitive-placeholder"\n account "billing"',
  "default login alice account sensitive-placeholder",
  "machine api.example \\\n login alice \\\n password sensitive-placeholder",
  "password sensitive-placeholder", "password\n sensitive-placeholder", "account sensitive-placeholder",'login "sensitive-placeholder"',
  ".netrc output:\nlogin sensitive-placeholder",
 ];
 for(const snippet of snippets)for(const text of [snippet,JSON.stringify(snippet),JSON.stringify({output:snippet}),encodeURIComponent(snippet)]){
  assert.ok(!sanitizeObservationText(text).includes("sensitive-placeholder"));
  assert.ok(!JSON.stringify(projectItem({id:"c",type:"commandExecution",command:"cat ~/.netrc",aggregatedOutput:text},turn)).includes("sensitive-placeholder"));
 }
 for(const path of ['cat /Users/alice/.netrc',encodeURIComponent('/Users/alice/.netrc')])assert.ok(!sanitizeObservationText(path).includes('.netrc'));
 assert.equal(sanitizeObservationText("Fix the login screen"),"Fix the login screen");assert.equal(sanitizeObservationText("login screen"),"login screen");
});

test("canonical pgpass/Redis config/htpasswd形式はcredential fileとして省略する",()=>{
 const lines=["db.example:5432:app:alice:sensitive-placeholder","localhost:*:*:alice:sensitive-placeholder",String.raw`db:5432:app:alice:sensitive\:placeholder`,"requirepass sensitive-placeholder",'masterauth "sensitive-placeholder"',"alice:$apr1$salt$sensitive-placeholder","alice:$2y$10$sensitive-placeholder","alice:{SHA}AAAAAAAAAAAAAAAAAAAAAAAAAAA="];
 for(const line of lines)for(const text of [line,JSON.stringify({output:line}),JSON.stringify(`header\n${line}\nfooter`),encodeURIComponent(line)]){
  assert.equal(sanitizeObservationText(text),"[認証ファイル形式の内容を省略]");
  assert.ok(!JSON.stringify(projectItem({id:"c",type:"commandExecution",aggregatedOutput:text},turn)).includes("sensitive"));
 }
 for(const value of ["src/main.ts:12:4: error expected value","name:value","https://example.com:5432/path","npm test: 42 passed"])assert.equal(sanitizeObservationText(value),value);
 for(const file of [".pgpass",".htpasswd"])for(const text of [`cat /Users/alice/${file}`,encodeURIComponent(`/Users/alice/${file}`)])assert.ok(!sanitizeObservationText(text).includes(file));
});


test("Azure接続文字列のAccountKeyと標準SASは既知credentialとして省略する",()=>{
 const secret="c2Vuc2l0aXZlLXBsYWNlaG9sZGVy";
 for(const key of ["AccountKey","account_key","ACCOUNT_KEY","SharedAccessSignature","SharedAccessKey","AzureSharedAccessKey","ClientSecret"]){
  const connection=`DefaultEndpointsProtocol=https;AccountName=foo;${key}=${secret};EndpointSuffix=core.windows.net`;
  for(const text of [connection,JSON.stringify({connection}),`${key}: | # credential\n  ${secret}`]){
   assert.equal(sanitizeObservationText(text),"[機密情報を含む内容を省略]");
   assert.ok(!JSON.stringify(projectItem({id:"command",type:"commandExecution",command:"show configuration",aggregatedOutput:text},turn)).includes(secret));
  }
 }
 for(const ordinary of ["Key=display-name;AccountName=foo","KeyVaultKey=public-key-name","DefaultEndpointsProtocol=https;AccountName=foo;EndpointSuffix=core.windows.net"])assert.equal(sanitizeObservationText(ordinary),ordinary);
});

test("既知設定CLIのcredential name whitespace valueは共通名判定で省略する",()=>{
 const commands=[
  "aws configure set aws_secret_access_key sensitive-placeholder",
  "aws --profile dev configure set profile.dev.aws_secret_access_key sensitive-placeholder",
  "aws configure set aws_session_token 'sensitive-placeholder'",
  "git config --global service.password sensitive-placeholder",
  "git -C ./repo config set service.token sensitive-placeholder",
  "git config --file ./config http.auth sensitive-placeholder",
  "npm config set _auth sensitive-placeholder",
  "npm config set //registry.example/:_authToken sensitive-placeholder",
  "pnpm config set _auth sensitive-placeholder",
  "yarn config set npmAuthToken sensitive-placeholder",
  "redis-cli CONFIG SET requirepass sensitive-placeholder",
  "redis-cli CONFIG SET masterauth sensitive-placeholder",
  "aws configure set \\\n aws_secret_access_key sensitive-placeholder",
 ];
 for(const command of commands)for(const text of [command,JSON.stringify({command}),encodeURIComponent(command)]){
  assert.ok(!sanitizeObservationText(text).includes("sensitive-placeholder"),command);
  assert.ok(!JSON.stringify(projectItem({id:"command",type:"commandExecution",command:text,aggregatedOutput:text},turn)).includes("sensitive-placeholder"),command);
 }
 for(const ordinary of ["aws configure set region us-east-1","git config --global user.name alice","git config set core.editor vim","npm config set registry https://registry.example","We should document aws configure set and the login screen","The token name is explained here","echo secret documentation"])assert.equal(sanitizeObservationText(ordinary),ordinary);
});

test("GitLab公式の固定token prefixは単独値・encoded値・tool出力でも省略する",()=>{
 // https://docs.gitlab.com/security/tokens/#token-prefixes (custom PAT prefixは対象外)
 for(const prefix of ["glpat-","gloas-","gldt-","glrt-","glrtr-","glcbt-","glptt-","glft-","glimt-","glagent-","glwt-","glsoat-","glffct-","_gitlab_session="]){
  const token=prefix+"1234567890abcdefghij";
  for(const text of [token,JSON.stringify({value:token}),encodeURIComponent(token),token.replaceAll("g",String.raw`\u0067`)]){
   assert.ok(!sanitizeObservationText(text).includes("1234567890abcdefghij"),prefix);
   assert.ok(!JSON.stringify(projectItem({id:"cmd",type:"commandExecution",command:"inspect",aggregatedOutput:text},turn)).includes("1234567890abcdefghij"),prefix);
  }
 }
 assert.equal(sanitizeObservationText("gitlab build passed"),"gitlab build passed");
});

test("fileChange update移動先はbounded DTOとcache再読で保持し保護pathを除去する",async()=>{
 const changes=[{path:"src/old.ts",kind:{type:"update",move_path:"src/new.ts"},diff:"@@ -1 +1 @@\n-old\n+new"},{path:"src/no-diff.ts",kind:{type:"update",move_path:"src/moved.ts"}},{path:"src/huge.ts",kind:{type:"update",move_path:"src/moved-huge.ts"},diff:"x".repeat(131073)},{path:"src/null.ts",kind:{type:"update",move_path:null},diff:""},{path:"src/add.ts",kind:{type:"add",move_path:"unexpected"},diff:"new"}];
 const item=projectItem({id:"moves",type:"fileChange",changes},turn)!;
 assert.deepEqual(item.files?.[0],{path:"src/old.ts",change:"update",move_path:"src/new.ts",additions:1,deletions:1});
 assert.equal(item.files?.[1]?.move_path,"src/moved.ts");assert.equal(item.files?.[2]?.move_path,"src/moved-huge.ts");assert.equal(item.files?.[3]?.move_path,undefined);assert.equal(item.files?.[4]?.move_path,undefined);
 const privateItem=projectItem({id:"private_move",type:"fileChange",changes:[{path:"src/a",kind:{type:"update",move_path:"/Users/alice/.codex/auth.json"},diff:""}]},turn)!;
 assert.ok(!JSON.stringify(privateItem).includes("alice"));assert.ok(!JSON.stringify(privateItem).includes("auth.json"));
 const bounded=sanitizeConversationItem({...item,files:[{path:"src/a",change:"update",move_path:"x".repeat(1025)}]})!;assert.equal(bounded.files?.[0]?.move_path?.length,1024);assert.equal(bounded.truncated,true);
 const fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path"),{RuntimeStore}=await import("../src/app-server/store.js");const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-details-move-")),store=new RuntimeStore(path.join(root,"r.db"));
 try{
  store.cacheItem("a","g",item);assert.deepEqual(store.cachedItems("a","g"),[item]);
  store.db.prepare("UPDATE observation_items SET item_json=?").run(JSON.stringify({...item,files:[{path:"src/a",change:"update",move_path:"/Users/alice/.codex/auth.json",raw:"hidden"}]}));
  const cached=store.cachedItems("a","g")[0]!;assert.ok(cached.files?.[0]?.move_path);assert.ok(!JSON.stringify(cached).includes("alice"));assert.ok(!JSON.stringify(cached).includes("hidden"));
 }finally{store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("file pathは1024文字境界を超えた場合だけtruncatedを保持する",()=>{
 for(const length of [1023,1024,1025]){
  const item=projectItem({id:"path",type:"fileChange",changes:[{path:"x".repeat(length),kind:{type:"update"},diff:""}]},turn)!;
  assert.equal(item.files?.[0]?.path.length,Math.min(length,1024));assert.equal(item.truncated,length>1024?true:undefined);
  assert.deepEqual(sanitizeConversationItem(item),item);
 }
 const cached=sanitizeConversationItem({id:"old",turn_id:turn,kind:"tool_progress",tool_type:"fileChange",files:[{path:"x".repeat(1025),change:"add"}]})!;
 assert.equal(cached.truncated,true);assert.equal(cached.files?.[0]?.path.length,1024);
});

test("registry loginのpassword optionを省略しrunのportや通常commandを残す",()=>{
 for(const cli of ["docker login","podman login","helm registry login"]){
  for(const option of ["-p sensitive-placeholder","-psensitive-placeholder","--password sensitive-placeholder","--password=sensitive-placeholder"]){
   const command=`${cli} -u alice ${option} registry.example`;
   for(const value of [command,JSON.stringify(command),encodeURIComponent(command),command.replaceAll(" ","\\\n ")]){
    assert.ok(!sanitizeObservationText(value).includes("sensitive-placeholder"));
    assert.ok(!JSON.stringify(projectItem({id:"login",type:"commandExecution",command:value},turn)).includes("sensitive-placeholder"));
   }
  }
 }
 for(const command of ["docker run -p 8080:80 nginx","podman run -p8080:80 nginx","helm template app ./chart","docker login -u alice","docker login -u alice && docker run -p8080:80 nginx","npm test"]){assert.equal(sanitizeObservationText(command),command);}
});

test("registry loginのglobal optionを認識し別commandのlogin文字列と区別する",()=>{
 for(const command of [
  "docker --context dev login -p sensitive-placeholder registry.example",
  "docker --context=dev --debug login -psensitive-placeholder registry.example",
  "docker --config '/tmp/config dir' login -p sensitive-placeholder",
  "podman --connection remote login -p sensitive-placeholder",
  "podman --remote --connection=remote login -p sensitive-placeholder",
  "helm --kube-context dev registry login -p sensitive-placeholder registry.example",
  "helm --debug --namespace=dev registry login -psensitive-placeholder",
  "sudo /usr/local/bin/docker --context dev login -p sensitive-placeholder",
  "npm test && docker --context dev login -p sensitive-placeholder",
 ]){
  for(const value of [command,JSON.stringify(command),encodeURIComponent(command)])assert.ok(!sanitizeObservationText(value).includes("sensitive-placeholder"),command);
 }
 for(const command of [
  "docker --context dev run -p8080:80 nginx",
  "podman --connection remote run -p 8080:80 nginx",
  "helm --kube-context dev template app ./chart",
  "docker --context dev ps && echo login -p example",
 ])assert.equal(sanitizeObservationText(command),command);
});


test("registry credentialはJSON・code wrapper・echo引用内も表示しない",()=>{
 const command="docker --context dev login -p sensitive-placeholder registry.example";
 for(const value of [JSON.stringify({command}),JSON.stringify(JSON.stringify({command})),`command: ${command}`,`code: ${command}`,`example: ${command}`,`echo "${command}"`]){
  assert.ok(!sanitizeObservationText(value).includes("sensitive-placeholder"));
  assert.ok(!JSON.stringify(projectItem({id:"wrapped",type:"mcpToolCall",tool:"exec",arguments:{code:value},result:{content:[{type:"text",text:value}]}},turn)).includes("sensitive-placeholder"));
 }
});

test("OpenSSL passphrase source引数は既知optionに限定して省略する",()=>{
 for(const flag of ["-passin","-passout","-password","-passcerts","-pass","-k","-kfile","-K"]){
  for(const source of ["pass:sensitive-placeholder","env:SENSITIVE_PLACEHOLDER","file:/tmp/sensitive-placeholder","fd:3","stdin"]){
   const command=`openssl pkcs12 ${flag} ${source}`;
   for(const value of [command,JSON.stringify({command}),encodeURIComponent(command)])assert.ok(sanitizeObservationText(value).includes("省略"));
  }
 }
 assert.ok(sanitizeObservationText("openssl passwd -1 sensitive-placeholder").includes("省略"));
 assert.equal(sanitizeObservationText("openssl passwd -help"),"openssl passwd -help");
 assert.equal(sanitizeObservationText("openssl version"),"openssl version");
 assert.equal(sanitizeObservationText("openssl dgst -sha256 src/a.ts"),"openssl dgst -sha256 src/a.ts");
});

test("pgpassのescaped IPv6 hostとescaped colon/backslashを5fieldとして検出する",()=>{
 for(const value of [String.raw`\:\:1:5432:db:user:sensitive-placeholder`,String.raw`2001\:db8\:\:1:5432:db:user:sensitive-placeholder`,String.raw`localhost:5432:db\:name:user:sensitive\:placeholder`,String.raw`localhost:5432:db:user:sensitive\\placeholder`]){
  for(const text of [value,`first\n${value}\nlast`,JSON.stringify(value),encodeURIComponent(value)])assert.ok(sanitizeObservationText(text).includes("認証ファイル"),text);
 }
 for(const value of ["src/file.ts:12:3: warning message","https://example.com:443/a","label:port:database:user:value"])assert.equal(sanitizeObservationText(value),value);
});

test("functionCallOutputはstring/input_textだけをbounded sanitizeしcache再読する",async()=>{
 const item=projectItem({id:"function",type:"functionCallOutput",name:"exec",namespace:"hidden",output:[{type:"input_text",text:"3 tests passed"},{type:"input_image",image_url:"hidden"},{type:"input_audio",audio_url:"hidden"},{type:"encrypted_content",encrypted_content:"hidden"},{type:"output_text",text:"hidden"}],status:"completed"},turn)!;
 assert.equal(item.output,"3 tests passed");assert.equal(item.status,undefined);assert.ok(!JSON.stringify(item).includes("hidden"));
 assert.equal(projectItem({id:"s",type:"functionCallOutput",output:"done"},turn)?.output,"done");
 assert.ok(!projectItem({id:"s",type:"functionCallOutput",output:[{type:"input_text",text:"TOKEN="},{type:"input_text",text:"sensitive-placeholder"}]},turn)?.output?.includes("sensitive-placeholder"));
 const huge=projectItem({id:"h",type:"functionCallOutput",output:[{type:"input_text",text:"x".repeat(9000)}]},turn)!;assert.equal(huge.truncated,true);assert.equal(huge.output?.length,8192);
 const fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path"),{RuntimeStore}=await import("../src/app-server/store.js");const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-function-output-")),store=new RuntimeStore(path.join(root,"r.db"));
 try{store.cacheItem("a","g",item);assert.deepEqual(store.cachedItems("a","g"),[item]);store.db.prepare("UPDATE observation_items SET item_json=?").run(JSON.stringify({...item,output:"TOKEN=sensitive-placeholder",raw:"hidden"}));assert.ok(!JSON.stringify(store.cachedItems("a","g")).includes("sensitive-placeholder"));assert.ok(!JSON.stringify(store.cachedItems("a","g")).includes("hidden"));}
 finally{store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("既知CLIのcredential optionはwrapper/混在commandにも漏らさずport引数は保持する",()=>{
 for(const command of [
  "security add-generic-password -s app -a user -w sensitive-placeholder",
  "security add-internet-password -s app -a user -wsensitive-placeholder",
  "security unlock-keychain -p sensitive-placeholder login.keychain-db",
  "security set-keychain-password -o sensitive-placeholder login.keychain-db",
  "ssh-keygen -t ed25519 -N sensitive-placeholder -f sample-key",
  "ssh-keygen -p -P sensitive-placeholder -N new-placeholder -f sample-key",
  "keytool -list -keystore demo.jks -storepass sensitive-placeholder",
  "keytool -importkeystore -srcstorepass sensitive-placeholder",
  "mongosh --host localhost -u user -p sensitive-placeholder",
  "sqlcmd -S localhost -U user -P sensitive-placeholder",
  "az login --service-principal -u app -p sensitive-placeholder --tenant example",
  "gpg --batch --passphrase sensitive-placeholder --decrypt sample.gpg",
 ]){
  for(const text of [command,JSON.stringify({command}),`npm test && ${command}`,`${command}; npm test`]){
   assert.ok(!sanitizeObservationText(text).includes("sensitive-placeholder"),command);
   assert.ok(!JSON.stringify(projectItem({id:"credential",type:"commandExecution",command:text,aggregatedOutput:text},turn)).includes("sensitive-placeholder"),command);
  }
 }
 for(const command of ["ssh -p 2222 host","ssh-keygen -l -f sample-key.pub","docker run -p 8080:80 nginx","gpg --list-keys","security list-keychains","keytool -list","mongosh --port 27017","sqlcmd -S localhost","az account show"])assert.equal(sanitizeObservationText(command),command);
});


test("pgpass field値のbackslash・zone・空白・引用符を過剰制限しない",()=>{
 for(const value of [String.raw`host\\name:5432:db:user:sensitive-placeholder`,String.raw`fe80\:\:1%en0:5432:db:user:sensitive-placeholder`,String.raw`localhost:5432:db:user:sensitive placeholder`,String.raw`localhost:5432:db:user:"sensitive-placeholder"`,String.raw`localhost:5432:db:user:'sensitive-placeholder'`]){
  for(const text of [value,JSON.stringify({output:value}),JSON.stringify(JSON.stringify({output:value}))])assert.ok(sanitizeObservationText(text).includes("認証ファイル"),text);
 }
 // 5fieldと数値portに一致する診断は認証行と曖昧なので保守的に省略する。
 assert.ok(sanitizeObservationText("src/file.ts:12:3: warning: message").includes("認証ファイル"));
 assert.equal(sanitizeObservationText("src/file.ts:12:3: warning message"),"src/file.ts:12:3: warning message");
});

test("認証CLI itemの裸stdout/errorは保存前とmarker付きcache再読の双方で抑制する",async()=>{
 const command="security find-generic-password -w -s example";
 const item=projectItem({id:"secret_cli",type:"commandExecution",command,aggregatedOutput:"sensitive-placeholder",status:"completed"},turn)!;
 assert.equal(item.command,"[認証optionを含む内容を省略]");assert.equal(item.output,item.command);
 for(const source of [command,item.command]){
  const dto=sanitizeConversationItem({...item,command:source,input:"other naked value",output:"sensitive-placeholder",error:"sensitive-placeholder"})!;
  assert.equal(dto.input,item.command);assert.equal(dto.output,item.command);assert.equal(dto.error,item.command);
 }
 const mcp=projectItem({id:"mcp_credential",type:"mcpToolCall",tool:"exec",arguments:{command},result:{content:[{type:"text",text:"sensitive-placeholder"}]},error:{message:"sensitive-placeholder"}},turn)!;
 assert.ok(!JSON.stringify(mcp).includes("sensitive-placeholder"));assert.equal(mcp.output,item.command);
 const fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path"),{RuntimeStore}=await import("../src/app-server/store.js");const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-credential-output-")),store=new RuntimeStore(path.join(root,"r.db"));
 try{store.cacheItem("a","g",item);assert.ok(!JSON.stringify(store.db.prepare("SELECT item_json FROM observation_items").all()).includes("sensitive-placeholder"));store.db.prepare("UPDATE observation_items SET item_json=?").run(JSON.stringify({...item,output:"sensitive-placeholder",error:"sensitive-placeholder"}));const cached=store.cachedItems("a","g")[0]!;assert.ok(!JSON.stringify(cached).includes("sensitive-placeholder"));assert.deepEqual(sanitizeConversationItem(cached),cached);}
 finally{store.close();await fs.rm(root,{recursive:true,force:true});}
 const ordinary=projectItem({id:"normal_cli",type:"commandExecution",command:"npm test",aggregatedOutput:"3 passed"},turn)!;assert.equal(ordinary.output,"3 passed");
});

test("既知config readのcredential名は裸stdoutをitem単位で抑制する",()=>{
 for(const command of ["aws configure get aws_secret_access_key","aws --profile dev configure get aws_access_key_id","npm config get _authToken","pnpm config get _auth","git config --get credential.password","git config get service.api-key","git config credential.password","redis-cli CONFIG GET requirepass"]){
  const item=projectItem({id:"config_read",type:"commandExecution",command,aggregatedOutput:"sensitive-placeholder"},turn)!;
  assert.equal(item.command,"[認証optionを含む内容を省略]",command);assert.equal(item.output,item.command);
  assert.deepEqual(sanitizeConversationItem(item),item);
 }
 for(const command of ["aws configure get region","npm config get registry","git config --get user.name","git config get user.email"]){assert.equal(sanitizeObservationText(command),command);}
});

test("credential由来markerはCLI以外でもitemの裸出力を抑制しpath置換では抑制しない",()=>{
 for(const command of ["MY_SECRET=value env","echo glpat-1234567890abcdefghij","machine host login user password value","host:5432:db:user:value","-----BEGIN PRIVATE KEY-----\nvalue"]){
  for(const source of [command,sanitizeObservationText(command)]){
   const item=sanitizeConversationItem({id:"credential_marker",turn_id:turn,kind:"tool_progress",tool_type:"commandExecution",command:source,output:"sensitive-placeholder",error:"sensitive-placeholder",input:"bare-input"})!;
   assert.ok(!JSON.stringify(item).includes("sensitive-placeholder"));assert.equal(item.input,"[認証optionを含む内容を省略]");assert.deepEqual(sanitizeConversationItem(item),item);
  }
  const projected=projectItem({id:"raw_credential",type:"commandExecution",command,aggregatedOutput:"sensitive-placeholder"},turn)!;assert.ok(!JSON.stringify(projected).includes("sensitive-placeholder"));
 }
 for(const command of ["cat /Users/alice/project/README.md","cat /Users/alice/.codex/auth.json","npm test"]){
  const item=projectItem({id:"path_only",type:"commandExecution",command,aggregatedOutput:"normal output"},turn)!;assert.equal(item.output,"normal output");
 }
});
