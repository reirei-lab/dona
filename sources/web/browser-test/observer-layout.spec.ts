import { test, expect, type Page } from '@playwright/test';
import { observerDashboardPage } from '../src/observer-dashboard.js';
const at='2026-10-06T00:00:00Z';
const message=`## 検証結果

**現在の状態**と[変更内容](https://example.com/pull/42)を確認してください。

| 項目 | 状態 | 件数 |
| :--- | :--- | ---: |
| 型チェック | 完了 | 12 |
| ブラウザ検証 | 実行中 | 8 |

- [x] 接続を確認
- [ ] レビューを確認

> 反映先の確認が必要です。

\`\`\`ts
const state = "running";
\`\`\`

<script>window.donaMarkdownExecutionSentinel=true</script>

[危険](javascript:alert(1)) [データ](data:text/html,test) [認証付き](https://user:pass@example.com) ![画像](https://external.test/image.png)
`;
async function setup(page:Page,items?:Record<string,unknown>[],events:Record<string,unknown>[]=[] ) {
 const requests:string[]=[];
 await page.route('https://observer.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/'){await route.fulfill(observerDashboardPage());return;}
  requests.push(path);
  const task={task_id:'task_0',task_key:'ダッシュボードの改善',state:'running',worker_status:'running',updated_at:at};
  const value=path==='/api/session'?{csrf:'test',capabilities:['tasks:read','conversations:main:read','tasks:submit']}:
   path==='/api/conversations/main'?{items:[{name:'Dona',generation:'current',connected:true,state:'working',observed_at:at}]}:
   path==='/api/tasks'?{items:Array.from({length:35},(_,i)=>({...task,updated_at:new Date(Date.parse(at)-i*i*180000).toISOString(),state:['running','waiting','completed','failed','idle'][i%5],wait_reason:i%5===1?'human_input':null,task_id:'task_'+i,task_key:i===0?task.task_key:'実行環境の検証 '+i})),next:null}:
   {snapshot:{task,attempts:[{attempt_id:'attempt_1',number:1,status:'running'}],request:'会話表示とMarkdownの検証'},runtime:{status:'observed',conversation:{name:'worker',generation:'current',state:'working',connected:true,observed_at:at,items:items??Array.from({length:20},(_,i)=>({id:'message_'+i,kind:i===0?'user_message':'assistant_message',text:i===0?'テーブルとリンクの表示を改善してください。':message})),events}}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://observer.test/');await page.locator('[data-task="task_0"]').click();await expect(page.locator('.markdown table').first()).toBeVisible();return requests;
}
async function trackFirstFrame(page:Page) {
 await page.addInitScript(()=>{
  const state=window as unknown as {conversationFirstFrame:number[]};state.conversationFirstFrame=[];
  new MutationObserver(records=>{
   const detail=document.querySelector('#detail');
   if(detail?.querySelector('.messages')&&records.some(record=>record.target===detail))state.conversationFirstFrame.push(Math.abs(detail.scrollHeight-detail.clientHeight-detail.scrollTop));
  }).observe(document,{childList:true,subtree:true});
 });
}
test('Markdownの表・リンク・コード・リストを表示しHTMLと危険なリンクを無効化する',async({page})=>{
 await setup(page);
 const entry=page.locator('[data-item="message_1"]');
 await expect(entry.locator('th')).toHaveText(['項目','状態','件数']);
 await expect(entry.getByRole('link',{name:'変更内容'})).toHaveAttribute('href','https://example.com/pull/42');
 await expect(entry.getByRole('link')).toHaveCount(1);
 await expect(entry.locator('pre code')).toHaveText('const state = "running";');
 await expect(entry.locator('input[type=checkbox]')).toHaveCount(2);
 await expect(entry.locator('li').first()).toHaveText('接続を確認');
 await expect(entry.locator('input[type=checkbox]').first()).toBeChecked();
 await expect(entry.locator('script,img,iframe,style')).toHaveCount(0);
 await expect(entry).toContainText('<script>window.donaMarkdownExecutionSentinel=true</script>');
 expect(await page.evaluate(()=>Object.hasOwn(window,'donaMarkdownExecutionSentinel'))).toBe(false);
});
test('右ペインは初回に最新へ移動し同じ内容の更新と左ペインの位置を保持する',async({page})=>{
 await trackFirstFrame(page);
 await page.setViewportSize({width:1440,height:900});await setup(page);
 const nav=page.locator('nav'),detail=page.locator('#detail');
 expect(await page.evaluate(()=>(window as unknown as {conversationFirstFrame:number[]}).conversationFirstFrame[0])).toBeLessThan(2);
 await expect.poll(()=>detail.evaluate(e=>Math.abs(e.scrollHeight-e.clientHeight-e.scrollTop))).toBeLessThan(2);
 await nav.evaluate(e=>e.scrollTop=400);await detail.evaluate(e=>e.scrollTop=500);
 expect(await nav.evaluate(e=>e.scrollTop)).toBe(400);expect(await detail.evaluate(e=>e.scrollTop)).toBe(500);
 await page.getByRole('button',{name:'更新',exact:true}).click();
 await expect.poll(()=>detail.evaluate(e=>e.scrollTop)).toBe(500);
 expect(await nav.evaluate(e=>e.scrollTop)).toBe(400);
 expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight)).toBe(true);
 await nav.evaluate(e=>e.scrollTop=0);await detail.evaluate(e=>e.scrollTop=0);
 await page.screenshot({path:'/tmp/dona-dashboard-desktop.png'});
});
for(const size of [{width:375,height:800},{width:800,height:375}])test('狭い画面でも会話と操作にアクセスできる '+size.width,async({page})=>{
 await page.setViewportSize(size);await setup(page);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('#objective').fill('新しい依頼');await expect(page.locator('#objective')).toBeVisible();
 await expect.poll(()=>page.locator('#detail').evaluate(e=>Math.abs(e.scrollHeight-e.clientHeight-e.scrollTop))).toBeLessThan(2);
 const beforeScroll=await page.locator('#detail').evaluate(e=>e.scrollTop);await page.locator('#detail').focus();await page.keyboard.press('PageUp');await expect.poll(()=>page.locator('#detail').evaluate(e=>e.scrollTop)).toBeLessThan(beforeScroll);
 if(size.width===375)await page.screenshot({path:'/tmp/dona-dashboard-mobile.png'});
});


test('メタデータを分離し既知のターンと旧履歴の入力境界を保つ',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});
 await setup(page,[
  {id:'request_1',kind:'user_message',turn_id:'turn_1',text:'会話ターンを見分けやすくしてください。'},
  {id:'progress',kind:'assistant_message',turn_id:'turn_1',text:'上部の情報と会話を分け、ツール実行はコンパクトにまとめます。'},
  {id:'tool_1',kind:'tool_progress',turn_id:'turn_1',tool_type:'commandExecution',status:'completed',command:'npm run typecheck',exit_code:0,output:'Type check passed.'},
  {id:'message_1',kind:'assistant_message',turn_id:'turn_1',text:'変更を反映しました。\n\n| 対象 | 結果 |\n| --- | --- |\n| 会話表示 | ターン単位に整理 |\n| 型チェック | 成功 |'},
  {id:'request_2',kind:'user_message',turn_id:'turn_2',text:'ツールの出力も確認できますか？'},
  {id:'answer_2',kind:'assistant_message',turn_id:'turn_2',text:'「実行結果を表示」を開くと確認できます。'},
  {id:'legacy_user',kind:'user_message',text:'以前の履歴も表示してください。'},
  {id:'legacy_answer',kind:'assistant_message',text:'保存済みの履歴を表示します。'},
 ]);
 const metadata=page.getByRole('region',{name:'会話の情報'});
 await expect(metadata).toContainText('Task: 実行中');await expect(metadata.locator('.messages')).toHaveCount(0);
 const turns=page.locator('.conversation-turn');await expect(turns).toHaveCount(3);
 await expect(turns.nth(0).locator('article')).toHaveCount(4);await expect(turns.nth(1).locator('article')).toHaveCount(2);await expect(turns.nth(2).locator('article')).toHaveCount(2);
 const request=metadata.locator('details').filter({has:page.getByText('依頼内容',{exact:true})});
 await request.locator('summary').click();await expect(request).toHaveAttribute('open','');
 await page.getByRole('button',{name:'更新',exact:true}).click();await expect(request).toHaveAttribute('open','');
 await request.locator('summary').click();
 await page.screenshot({path:'/tmp/dona-dashboard-turns.png'});
});

test('日時の出典を区別しApp Serverの日時を観測時刻より優先する',async({page})=>{
 await page.clock.setFixedTime(new Date('2026-10-06T00:03:00Z'));
 await page.setViewportSize({width:1440,height:1800});
 const started='2026-10-05T23:59:58.123Z',completed='2026-10-06T00:00:02.456Z';
 await setup(page,[
  {id:'message_1',turn_id:'t',kind:'assistant_message',text:'状態表示を色付きのインジケータに整理しました。\n\n| 確認項目 | 結果 |\n| --- | --- |\n| 状態の識別 | 色とツールチップで確認 |\n| キーボード操作 | 対応 |'},
  {id:'tool',turn_id:'t',kind:'tool_progress',tool_type:'commandExecution',command:'npm test',status:'completed'},
  {id:'history',turn_id:'old',kind:'user_message',text:'履歴の依頼',turn_started_at:started},
  {id:'observed',turn_id:'old',kind:'assistant_message',text:'旧バージョンの観測履歴'},
  {id:'missing',turn_id:'old',kind:'assistant_message',text:'日時のない履歴'},
 ],[
  {kind:'item/completed',turn_id:'t',item_id:'message_1',occurred_at:completed,observed_at:'2026-10-07T00:00:00Z'},
  {kind:'item/completed',turn_id:'t',item_id:'message_1',observed_at:'2026-10-08T00:00:00Z'},
  {kind:'item/started',turn_id:'t',item_id:'tool',occurred_at:started,observed_at:at},
  {kind:'item/completed',turn_id:'t',item_id:'tool',occurred_at:completed,observed_at:at},
  {kind:'item/completed',turn_id:'old',item_id:'observed',observed_at:at},
  {kind:'item/completed',turn_id:'wrong',item_id:'missing',occurred_at:completed,observed_at:at},
 ]);
 await expect(page.locator('[data-item="message_1"] time')).toHaveAttribute('datetime',completed);
 await expect(page.locator('[data-item="message_1"] .message-times')).not.toContainText('観測');
 await expect(page.locator('[data-item="tool"] time').first()).toHaveAttribute('datetime',started);
 await expect(page.locator('[data-item="tool"] time').last()).toHaveAttribute('datetime',completed);
 await expect(page.locator('[data-item="tool"] .message-times')).toContainText('開始:');
 await expect(page.locator('[data-item="history"] .message-times')).toContainText('ターン開始:');
 await expect(page.locator('[data-item="observed"] .message-times')).toContainText('観測:');
 await expect(page.locator('[data-item="missing"] .message-times')).toHaveText('日時未記録');
 await page.locator('h1').click();await page.screenshot({path:'/tmp/dona-dashboard-relative-lists.png'});
});


test('状態は色付き丸で示しフォーカス・ホバー時と読み上げで名前を確認できる',async({page})=>{
 await setup(page);
 for(const [index,tone] of ['working','attention','success','error','neutral'].entries()) {
  const button=page.locator('[data-task="task_'+index+'"]');
  await expect(button.locator('.status-indicator')).toHaveAttribute('data-tone',tone);
 }
 const button=page.locator('[data-task="task_0"]'),tooltip=button.locator('.status-tooltip');
 await page.locator('h1').click();await expect(tooltip).toHaveCSS('opacity','0');
 await button.focus();await expect(tooltip).toHaveCSS('opacity','1');await expect(button).toHaveAccessibleName('ダッシュボードの改善 · 実行中');
 await page.locator('h1').click();await button.locator('.status-indicator').hover();await expect(tooltip).toHaveCSS('opacity','1');
 const badge=page.locator('.metadata-heading>.status-indicator');await badge.focus();await expect(badge).toHaveAccessibleName('Task: 実行中');await expect(badge.locator('.status-tooltip')).toHaveCSS('opacity','1');
});


test('Task一覧は相対時刻だけを表示し正確な日時と経過に伴う更新を維持する',async({page})=>{
 await page.clock.setFixedTime(new Date('2026-10-06T00:03:00Z'));await setup(page);
 const time=page.locator('[data-task="task_0"] time');
 await expect(time).toHaveText('3 分前');await expect(time).toHaveAttribute('datetime','2026-10-06T00:00:00.000Z');await expect(time).toHaveAttribute('title',/2026/);
 await expect(page.locator('[data-task="task_0"]')).not.toContainText('更新');
 await page.clock.setFixedTime(new Date('2026-10-06T02:00:00Z'));await page.getByRole('button',{name:'更新',exact:true}).click();await expect(time).toHaveText('2 時間前');
 await page.clock.setFixedTime(new Date('2026-10-06T00:00:15Z'));await page.getByRole('button',{name:'更新',exact:true}).click();await expect(time).toHaveText('たった今');
});

test('Shikiでコードを着色し本文・CSP・未対応言語の表示を維持する',async({page})=>{
 await page.setViewportSize({width:1440,height:1800});await page.clock.setFixedTime(new Date('2026-10-06T00:03:00Z'));
 const errors:string[]=[],outside:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(new URL(request.url()).origin!=='https://observer.test')outside.push(request.url());});
 await page.addInitScript(()=>{(window as unknown as {cspErrors:string[]}).cspErrors=[];document.addEventListener('securitypolicyviolation',event=>(window as unknown as {cspErrors:string[]}).cspErrors.push(event.violatedDirective));});
 const snippets=[
  ['ts', '// 現在の状態を取得\ninterface Task { id: string; state: "running" | "completed" }\n\nasync function loadTask(id: string): Promise<Task> {\n  const response = await fetch(`/api/tasks/${id}`);\n  if (!response.ok) throw new Error("取得に失敗しました");\n  return response.json();\n}'],
  ['json','{\n  "task_id": "task_42",\n  "state": "running",\n  "attempt": 3\n}'],
  ['bash','# 検証を実行\nnpm run typecheck && npm run test:browser'],
  ['swift','struct TaskStatus {\n    let id: String\n    var isRunning: Bool = true\n}'],
  ['python','def status(task):\n    return task.get("state", "unknown")'],
  ['html','<script>alert("literal")</script>'],
  ['unknown-lang','<img src=x onerror=alert(1)>'],
 ];
 const text='Shikiでコードブロックを表示します。\n\n| 言語 | 配色 |\n| --- | --- |\n| TypeScript / JSON / Shell | Monokai |\n\n'+snippets.map(([lang,code])=>'```'+lang+'\n'+code+'\n```').join('\n\n');
 await setup(page,[{id:'syntax',kind:'assistant_message',text}]);
 const blocks=page.locator('[data-item="syntax"] pre');await expect(blocks).toHaveCount(snippets.length);
 for(let i=0;i<snippets.length;i++){
  await expect(blocks.nth(i).locator('code')).toHaveText(snippets[i]![1]!,{useInnerText:false});
  if(i<snippets.length-1)await expect(blocks.nth(i)).toHaveAttribute('data-highlighter','shiki');
 }
 await expect(blocks.last()).not.toHaveAttribute('data-highlighter');
 const colors=await blocks.first().locator('.shiki-token').evaluateAll(nodes=>[...new Set(nodes.map(n=>getComputedStyle(n).color))]);expect(colors.length).toBeGreaterThan(2);
 await expect(page.locator('[data-item="syntax"] img, [data-item="syntax"] script, [data-item="syntax"] [style]')).toHaveCount(0);
 expect(await page.evaluate(()=>(window as unknown as {cspErrors:string[]}).cspErrors)).toEqual([]);expect(errors).toEqual([]);expect(outside).toEqual([]);
 await page.locator('h1').click();await page.screenshot({path:'/tmp/dona-dashboard-monokai.png'});
});

test('Mermaidのフローとシーケンスを図示し不正な記法はソースを保持する',async({page})=>{
 await page.setViewportSize({width:1440,height:1800});await page.clock.setFixedTime(new Date('2026-10-06T00:03:00Z'));
 const outside:string[]=[];page.on('request',r=>{if(!r.url().startsWith('blob:')&&new URL(r.url()).origin!=='https://observer.test')outside.push(r.url());});
 const flow='flowchart LR\n  A[依頼を受信] --> B{承認が必要?}\n  B -->|はい| C[承認待ち]\n  B -->|いいえ| D[ワーカー実行]\n  C --> D\n  D --> E[結果を保存]';
 const sequence='sequenceDiagram\n  participant U as ユーザー\n  participant D as Dona\n  participant W as ワーカー\n  U->>D: 作業を依頼\n  D->>W: Taskを開始\n  W-->>D: 進捗を通知\n  W-->>D: 実行結果\n  D-->>U: 結果を表示';
 const markdown='処理の流れを図で確認できます。\n\n| 図 | 内容 |\n| --- | --- |\n| フロー / シーケンス | Taskの実行 |\n\n```mermaid\n'+flow+'\n```\n\n```mermaid\n'+sequence+'\n```';
 await setup(page,[{id:'diagrams',kind:'assistant_message',text:markdown},{id:'invalid',kind:'assistant_message',text:'```mermaid\nnot a valid diagram\n```'},{id:'unsafe',kind:'assistant_message',text:'```mermaid\n%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\n A-->B\n```'}]);
 const figures=page.locator('[data-item="diagrams"] .mermaid-figure');
 for(let i=0;i<2;i++){await expect(figures.nth(i)).toHaveAttribute('data-rendered','true');await expect.poll(()=>figures.nth(i).locator('img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(100);}
 await expect(page.locator('[data-item="invalid"] .mermaid-figure')).toHaveAttribute('data-rendered','error');await expect(page.locator('[data-item="invalid"] details')).toHaveAttribute('open','');
 await expect(page.locator('[data-item="unsafe"] .mermaid-figure')).toHaveAttribute('data-rendered','error');
 await expect(page.locator('.mermaid-stage')).toHaveCount(0);await expect(page.locator('.mermaid-figure svg, .mermaid-figure iframe')).toHaveCount(0);expect(outside).toEqual([]);
 await figures.first().locator('summary').click();await expect(figures.first().locator('code')).toHaveText(flow);await figures.first().locator('summary').click();
 await page.locator('h1').click();await page.screenshot({path:'/tmp/dona-dashboard-mermaid.png'});
});

test('ファイル差分を行番号とMonokaiで表示し開閉状態と全文を保持する',async({page})=>{
 await page.clock.setFixedTime(new Date('2026-10-06T00:03:00Z'));
 await page.setViewportSize({width:1440,height:1800});
 const diff='diff --git a/src/status.ts b/src/status.ts\n--- a/src/status.ts\n+++ b/src/status.ts\n@@ -12,3 +12,7 @@\n export function formatStatus(state: string) {\n-  return state;\n+  const labels = {\n+    running: "実行中",\n+    completed: "完了",\n+  };\n+  return labels[state] ?? state;\n }\n@@ -30 +32 @@\n-const refreshInterval = 10000;\n+const refreshInterval = 5000;\n';
 await setup(page,[
 {id:'request',kind:'user_message',turn_id:'t',text:'状態表示と更新間隔を調整してください。'},
 {id:'progress',kind:'assistant_message',turn_id:'t',text:'状態の表示を整理し、更新間隔を5秒に変更します。'},
 {id:'changes',kind:'tool_progress',turn_id:'t',tool_type:'fileChange',status:'completed',files:[
 {path:'sources/web/src/status.ts',change:'update',additions:6,deletions:2,diff},
 {path:'sources/web/src/indicators.ts',change:'add',additions:3,deletions:0,diff:'export const colors = {\n  running: "#8ab4f8",\n};\n'},
 {path:'sources/web/src/old-status.ts',change:'delete',additions:0,deletions:1,diff:'export const label = "running";\n'},
 {path:'src/old.ts',move_path:'src/new.ts',change:'update',diff:''},
 {path:'src/history.ts',change:'update',additions:1,deletions:1}
 ]},
 {id:'result',kind:'assistant_message',turn_id:'t',text:'表示と更新間隔を変更しました。\n\n| 項目 | 内容 |\n| --- | --- |\n| 状態表示 | 日本語ラベルと色を整理 |\n| 更新間隔 | 5秒 |'}
 ],[{kind:'item/completed',turn_id:'t',item_id:'changes',occurred_at:'2026-10-06T00:01:12.000Z',observed_at:at}]);
 const boxes=page.locator('.file-diff');await expect(boxes).toHaveCount(5);
 await boxes.nth(0).locator(':scope > summary').click();await boxes.nth(1).locator(':scope > summary').click();await boxes.nth(2).locator(':scope > summary').click();
 await expect(boxes.nth(0).locator('.diff-delete').first().locator('.diff-number')).toHaveText(['13','']);
 await expect(boxes.nth(0).locator('.diff-add').last().locator('.diff-number')).toHaveText(['','32']);
 await expect(boxes.nth(0).locator('code[data-highlighter=shiki]').first()).toBeVisible();
 await page.getByRole('button',{name:'更新',exact:true}).click();await expect(boxes.nth(0)).toHaveAttribute('open','');
 await boxes.nth(4).locator('summary').click();await expect(boxes.nth(4)).toContainText('この履歴には差分本文がありません。');await boxes.nth(4).locator('summary').click();
 await boxes.nth(0).locator('.diff-source > summary').click();await expect(boxes.nth(0).locator('.diff-source pre')).toHaveText(diff);await boxes.nth(0).locator('.diff-source > summary').click();
 await page.locator('h1').click();await page.screenshot({path:'/tmp/dona-dashboard-diff.png'});
});

test('長い差分とHTML・credential風文字列も省略せず文字として表示する',async({page})=>{
 const source='const password = "example-only";\n<script>window.diffExecuted=true</script>\n'+'long line\n'.repeat(1800)+'LAST_LINE';
 await setup(page,[{id:'table',kind:'assistant_message',turn_id:'t',text:'| 項目 | 値 |\n| --- | --- |\n| 検証 | 全文 |'},{id:'f',kind:'tool_progress',turn_id:'t',tool_type:'fileChange',files:[{path:'.env',change:'add',diff:source}]}]);
 const box=page.locator('.file-diff');await box.locator('summary').click();
 await expect(box.locator('.diff-table code')).toHaveText(source.split('\n'));
 await expect(box.locator('script')).toHaveCount(0);expect(await page.evaluate(()=>Object.hasOwn(window,'diffExecuted'))).toBe(false);
 await page.setViewportSize({width:375,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('Dona本体も会話末尾へ追従する',async({page})=>{
 await trackFirstFrame(page);
 await page.setViewportSize({width:1440,height:1800});await page.clock.setFixedTime(new Date('2026-10-06T00:03:00Z'));await setup(page);
 let extra=false;
 await page.route('https://observer.test/api/conversations/main/Dona/current',route=>route.fulfill({json:{status:'observed',conversation:{name:'Dona',generation:'current',state:'working',connected:true,observed_at:at,events:[],items:[...Array.from({length:20},(_,i)=>({id:'log_'+i,turn_id:'t',kind:'assistant_message',text:'検証 '+(i+1)+'：ダッシュボードの会話表示を確認しています。'})),{id:'latest',turn_id:'t',kind:'assistant_message',text:extra?'最新の検証結果です。\n\n| 確認項目 | 結果 |\n| --- | --- |\n| 初回表示 | 最新の発言へ移動 |\n| 更新時 | 末尾へ追従 |\n| 左ペイン | スクロール位置を保持 |':'最新の状態を取得しています。'}]}}}));
 await page.locator('[data-main="Dona:current"]').click();
 const detail=page.locator('#detail');await expect(page.locator('[data-item="latest"]')).toContainText('最新の状態');
 expect(await page.evaluate(()=>(window as unknown as {conversationFirstFrame:number[]}).conversationFirstFrame.at(-1))).toBeLessThan(2);
 await expect.poll(()=>detail.evaluate(e=>Math.abs(e.scrollHeight-e.clientHeight-e.scrollTop))).toBeLessThan(2);
 await detail.evaluate(e=>e.scrollTop=0);extra=true;await page.getByRole('button',{name:'更新',exact:true}).click();
 await expect(page.locator('[data-item="latest"]')).toContainText('最新の検証結果');
 await expect.poll(()=>detail.evaluate(e=>Math.abs(e.scrollHeight-e.clientHeight-e.scrollTop))).toBeLessThan(2);
 await page.locator('h1').click();await page.screenshot({path:'/tmp/dona-dashboard-latest.png'});
});

test('入力・結果を開閉しても同じ会話の再取得でも閲覧位置を保持する',async({page})=>{
 await page.setViewportSize({width:1440,height:1100});
 await setup(page,[{id:'intro',turn_id:'t',kind:'assistant_message',text:'| 項目 | 状態 |\n| --- | --- |\n| 閲覧位置 | 検証中 |'},
 {id:'tool',turn_id:'t',kind:'tool_progress',tool_type:'mcpToolCall',tool_name:'repo.read',input:'query: ダッシュボードの表示',output:'表示内容の確認結果\n'+Array.from({length:8},(_,i)=>'確認 '+(i+1)).join('\n'),status:'completed'},
 ...Array.from({length:20},(_,i)=>({id:'tail'+i,turn_id:'t',kind:'assistant_message',text:'後続のメッセージ '+(i+1)}))]);
 const detail=page.locator('#detail'),tool=page.locator('[data-item="tool"]');
 await tool.getByText('入力を表示',{exact:true}).click();
 const before=await detail.evaluate(e=>e.scrollTop);
 await tool.getByText('実行結果を表示',{exact:true}).click();
 await expect(tool.locator('details[open]')).toHaveCount(2);
 await expect.poll(()=>detail.evaluate(e=>e.scrollTop)).toBe(before);
 await page.getByRole('button',{name:'更新',exact:true}).click();
 await expect(tool.locator('details[open]')).toHaveCount(2);
 await expect.poll(()=>detail.evaluate(e=>e.scrollTop)).toBe(before);
 await page.screenshot({path:'/tmp/dona-dashboard-expanded.png'});
 await tool.getByText('実行結果を表示',{exact:true}).click();await expect(tool.locator('details[open]')).toHaveCount(1);
 await expect.poll(()=>detail.evaluate(e=>e.scrollTop)).toBe(before);
});
