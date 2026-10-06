import {test,expect} from '@playwright/test';
import {observerDashboardPage} from '../src/observer-dashboard.js';
const at='2026-10-05T07:00:00.000Z';
test('再pair後は古い認証エラーを選択案内へ戻しmainとTaskの選択を区別する',async({page})=>{
 let paired=false;
 await page.route('https://observer.test/**',async route=>{
  const p=new URL(route.request().url()).pathname;if(p==='/'){await route.fulfill(observerDashboardPage());return;}
  if(p==='/api/pair'){paired=true;await route.fulfill({contentType:'application/json',body:'{}'});return;}
  if(!paired){await route.fulfill({status:401,body:'{}'});return;}
  const task={task_id:'task_one',task_key:'読み取り確認',state:'running',worker_status:'running',updated_at:at};
  const value=p==='/api/session'?{csrf:'csrf',capabilities:['tasks:read','conversations:main:read']}:p==='/api/tasks'?{items:[task],next:null}:p==='/api/conversations/main'?{items:[{name:'dona_main',generation:'current',connected:true,state:'idle',observed_at:at}]}:p.startsWith('/api/conversations/main/')?{status:'observed',conversation:{name:'dona_main',generation:'current',state:'idle',connected:true,observed_at:at,items:[],gap:false,truncated:false}}:{snapshot:{task,attempts:[],request:'依頼の本文 <b>literal</b>'},runtime:{status:'not_started'}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://observer.test/');await expect(page.locator('#detail')).toContainText('認証が必要');
 await page.locator('#code').fill('fixture');await page.locator('#pair-submit').click();
 await expect(page.locator('#connection')).toContainText('接続中');await expect(page.locator('#detail')).toContainText('会話を選んでください');await expect(page.locator('#detail')).not.toContainText('認証が必要');
 await page.locator('[data-main="dona_main:current"]').click();await expect(page.locator('[data-main="dona_main:current"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#detail')).toContainText('状態: 待機中');await expect(page.locator('#detail')).toContainText('表示できる発言やツール実行がまだありません');
 await page.locator('[data-task="task_one"]').click();await expect(page.locator('[data-main="dona_main:current"]')).toHaveAttribute('aria-pressed','false');await expect(page.locator('[data-task="task_one"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('[data-task="task_one"] time')).toHaveAttribute('title',/2026/);await expect(page.locator('#detail')).toContainText('依頼の本文 <b>literal</b>');await expect(page.locator('#detail b')).toHaveCount(0);
});
test('user・command・結果・error・filesをplain textで表示し省略と旧履歴の詳細欠落を明示する',async({page})=>{
 const malicious='<img src=x onerror=alert(1)>';
 const items=[{id:'user',kind:'user_message',text:'依頼: '+malicious},{id:'cmd',turn_id:'turn_one',kind:'tool_progress',tool_type:'commandExecution',command:'npm test '+malicious,output:'test output '+malicious,status:'completed',exit_code:0,duration_ms:1250,truncated:true},{id:'mcp',kind:'tool_progress',tool_type:'mcpToolCall',tool_name:'github.get_issue',input:'query: issue details '+malicious,status:'failed',error:'permission denied '+malicious},{id:'files',kind:'tool_progress',tool_type:'fileChange',status:'completed',files:[{path:'src/example.ts',change:'update',additions:4,deletions:2},{path:'src/old.ts',change:'update',move_path:'src/new-'+malicious+'.ts',additions:2,deletions:1},{path:'src/private.ts',change:'update',move_path:'[REDACTED]',additions:0,deletions:0}]},{id:'legacy',turn_id:'other_turn',kind:'tool_progress',tool_type:'webSearch',status:'interrupted'},{id:'collab',kind:'tool_progress',tool_type:'collabAgentToolCall',tool_name:'spawnAgent',status:'completed',input:'変更内容を確認してください',output:'completed: レビュー完了 <script>literal</script>'},{id:'collab_legacy',kind:'tool_progress',tool_type:'collabAgentToolCall',status:'inProgress'}];
 await page.route('https://observer.test/**',async route=>{
  const p=new URL(route.request().url()).pathname;if(p==='/'){await route.fulfill(observerDashboardPage());return;}
  const value=p==='/api/session'?{csrf:'csrf',capabilities:['conversations:main:read']}:p==='/api/conversations/main'?{items:[{name:'main',generation:'g',connected:true,state:'working',observed_at:at}]}:{status:'observed',conversation:{name:'main',generation:'g',connected:true,state:'working',observed_at:at,items,events:[{kind:'item/started',item_id:'cmd',turn_id:'turn_one',observed_at:at},{kind:'item/completed',item_id:'cmd',turn_id:'turn_one',observed_at:'2026-10-05T07:01:00.000Z'},{kind:'item/started',item_id:'legacy',turn_id:'wrong_turn',observed_at:at},{kind:'item/completed',item_id:'legacy',turn_id:'other_turn',observed_at:'invalid'}],gap:false,truncated:true}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://observer.test/');await page.locator('[data-main="main:g"]').click();
 for(const text of ['ユーザー・依頼入力','npm test '+malicious,'終了コード 0 · 所要時間 1.25 秒','github.get_issue','permission denied '+malicious,'更新src/example.ts+4−2','移動src/old.ts → src/new-'+malicious+'.ts+2−1','移動src/private.ts → [REDACTED]+0−0','この項目の内容は表示上限','詳細が記録されていません'])await expect(page.locator('#detail')).toContainText(text);
 await expect(page.locator('[data-item="cmd"]')).toContainText('開始を観測:');await expect(page.locator('[data-item="cmd"]')).toContainText('完了を観測:');await expect(page.locator('[data-item="legacy"]')).not.toContainText('を観測:');await expect(page.locator('[data-item="legacy"]')).toContainText('中断');
 await expect(page.locator('#detail img')).toHaveCount(0);const output=page.locator('[data-item="cmd"] details');await expect(output).not.toHaveAttribute('open','');await output.locator('summary').click();await expect(output.locator('pre')).toBeVisible();await expect(output.locator('pre')).toHaveText('test output '+malicious);
 await expect(page.locator('[data-item="collab"] h4')).toHaveText('spawnAgent');await expect(page.locator('[data-item="collab"] .state')).toHaveText('完了');await expect(page.locator('[data-item="collab_legacy"] h4')).toHaveText('サブエージェント操作');await expect(page.locator('[data-item="collab_legacy"] .state')).toHaveText('進行中');
 const collab=page.locator('[data-item="collab"]');await collab.getByText('入力を表示',{exact:true}).click();await expect(collab).toContainText('変更内容を確認してください');await collab.getByText('実行結果を表示',{exact:true}).click();await expect(collab).toContainText('completed: レビュー完了 <script>literal</script>');await expect(collab.locator('script')).toHaveCount(0);
 const input=page.locator('[data-item="mcp"] details');await input.locator('summary').click();await expect(input.locator('pre')).toHaveText('query: issue details '+malicious);
 await page.getByRole('button',{name:'更新',exact:true}).click();await expect(output).toHaveAttribute('open','');await expect(input).toHaveAttribute('open','');
});

test('画像生成は既知の状態だけを表示し画像データと保存先を描画しない',async({page})=>{
 const secret='private-image-sentinel',image='data:image/png;base64,c2VjcmV0';
 const statuses=[['inProgress','進行中'],['completed','完了'],['failed','失敗'],['interrupted','中断']];
 const items=statuses.map(([status])=>({id:'image_'+status,kind:'tool_progress',tool_type:'imageGeneration',status,
  // 投影外のfieldが届いても画像項目では汎用tool詳細として表示しない。
  tool_name:secret,text:secret,command:secret,input:secret,output:image,error:secret,
  files:[{path:'/private/'+secret+'.png',change:'add'}],result:image,revisedPrompt:secret,path:'/private/'+secret+'.png'}));
 await page.route('https://observer.test/**',async route=>{
  const p=new URL(route.request().url()).pathname;if(p==='/'){await route.fulfill(observerDashboardPage());return;}
  const value=p==='/api/session'?{csrf:'csrf',capabilities:['conversations:main:read']}:p==='/api/conversations/main'?{items:[{name:'main',generation:'g',connected:true,state:'working',observed_at:at}]}:{status:'observed',conversation:{name:'main',generation:'g',connected:true,state:'working',observed_at:at,items,events:[],gap:false,truncated:false}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://observer.test/');await page.locator('[data-main="main:g"]').click();
 for(const [status,translated] of statuses){
  const card=page.locator('[data-item="image_'+status+'"]');
  await expect(card.locator('h4')).toHaveText('画像生成');await expect(card.locator('.state')).toHaveText(translated!);
  await expect(card.locator('details, pre, img')).toHaveCount(0);
 }
 await expect(page.locator('#detail')).not.toContainText(secret);await expect(page.locator('#detail')).not.toContainText(image);
});

test('制御項目は種類と許可されたmetadataだけを表示し状態を補わない',async({page})=>{
 const types=[['sleep','待機'],['contextCompaction','会話の要約'],['enteredReviewMode','レビュー開始'],['exitedReviewMode','レビュー終了'],['subAgentActivity','サブエージェントの活動'],['functionCallOutput','ツールの応答']];
 const secret='private-control-payload';
 const items=types.map(([type])=>({id:type,turn_id:'turn',kind:'tool_progress',tool_type:type,
  ...(type==='sleep'?{duration_ms:1250}:{}),...(type==='functionCallOutput'?{tool_name:'functions.exec'}:{}),
  text:secret,input:secret,output:type==='functionCallOutput'?[{type:'image',data:secret},{type:'audio',data:secret}]:secret,command:secret,error:secret,files:[{path:secret,change:'add'}],review:secret,thread_id:secret}));
 await page.route('https://observer.test/**',async route=>{
  const p=new URL(route.request().url()).pathname;if(p==='/'){await route.fulfill(observerDashboardPage());return;}
  const value=p==='/api/session'?{csrf:'csrf',capabilities:['conversations:main:read']}:p==='/api/conversations/main'?{items:[{name:'main',generation:'g',connected:true,state:'working',observed_at:at}]}:{status:'observed',conversation:{name:'main',generation:'g',connected:true,state:'working',observed_at:at,items,events:[{kind:'item/started',item_id:'sleep',turn_id:'turn',observed_at:at}],gap:false,truncated:false}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://observer.test/');await page.locator('[data-main="main:g"]').click();
 for(const [type,title] of types){
  const card=page.locator('[data-item="'+type+'"]');await expect(card.locator('h4')).toHaveText(title!);
  await expect(card.locator('.state, details, pre, img')).toHaveCount(0);
 }
 await expect(page.locator('[data-item="sleep"]')).toContainText('所要時間 1.25 秒');
 await expect(page.locator('[data-item="sleep"]')).toContainText('開始を観測:');
 await expect(page.locator('[data-item="functionCallOutput"]')).toContainText('functions.exec');
 await expect(page.locator('#detail')).not.toContainText(secret);
});

test('functionCallOutputの投影済みテキストを折り畳み表示し生のmetadataやmediaを描画しない',async({page})=>{
 const output='4 tests passed\n<script>literal result</script>\nAuthorization: [REDACTED]',secret='unprojected-private-payload';
 const item={id:'result',kind:'tool_progress',tool_type:'functionCallOutput',tool_name:'functions.exec',output,truncated:true,
  text:secret,input:secret,error:secret,command:secret,files:[{path:secret,change:'add'}],metadata:{private:secret},image:'data:image/png;base64,'+secret,audio:secret,result:secret};
 await page.route('https://observer.test/**',async route=>{
  const p=new URL(route.request().url()).pathname;if(p==='/'){await route.fulfill(observerDashboardPage());return;}
  const value=p==='/api/session'?{csrf:'csrf',capabilities:['conversations:main:read']}:p==='/api/conversations/main'?{items:[{name:'main',generation:'g',connected:true,state:'working',observed_at:at}]}:{status:'observed',conversation:{name:'main',generation:'g',connected:true,state:'working',observed_at:at,items:[item],events:[],gap:false,truncated:false}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://observer.test/');await page.locator('[data-main="main:g"]').click();
 const card=page.locator('[data-item="result"]'),fold=card.locator('details');
 await expect(card.locator('h4')).toHaveText('ツールの応答');await expect(card).toContainText('functions.exec');
 await expect(fold).not.toHaveAttribute('open','');await fold.locator('summary').click();await expect(fold.locator('pre')).toHaveText(output);await expect(fold.locator('pre')).toBeVisible();
 await expect(card).toContainText('表示上限のため一部省略');await expect(card.locator('script, img, audio, .state')).toHaveCount(0);await expect(card).not.toContainText(secret);
 await page.getByRole('button',{name:'更新',exact:true}).click();await expect(fold).toHaveAttribute('open','');
});
