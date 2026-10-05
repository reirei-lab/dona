import {expect,test} from '@playwright/test';
import {observerDashboardPage} from '../src/observer-dashboard.js';
test('SSEの差分・gap・切断をsnapshotへ再接続し一時断のdraftは認証失効まで保持する',async({page})=>{
 let revision=1,mode='heartbeat',reads=0,streams=0,denied=false;const methods:string[]=[];
 await page.route('https://observer.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;methods.push(route.request().method());
  if(path==='/'){await route.fulfill(observerDashboardPage());return;}
  if(denied){await route.fulfill({status:401,body:'{}'});return;}
  if(path.endsWith('/events')){streams++;expect(route.request().headers()['last-event-id']).toBe('cursor_'+revision);await route.fulfill({contentType:'text/event-stream',body:mode==='oversize'?'x'.repeat(4097):`id: cursor_${revision}\nevent: ${mode}\ndata: {}\n\n`});return;}
  const task={task_id:'task_one',task_key:'Task one',state:'running',worker_status:'running',updated_at:'now'};
  let value:unknown;if(path==='/api/session')value={csrf:'csrf',capabilities:['tasks:read','tasks:submit']};else if(path==='/api/tasks')value={items:[task],next:null};else{reads++;value={snapshot:{task,attempts:[]},runtime:{status:'not_started'},stream_cursor:'cursor_'+revision};}
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://observer.test/');await page.locator('[data-task="task_one"]').click();await expect(page.locator('#detail h2')).toHaveText('Task one');await page.locator('#objective').fill('まだ送信していない依頼');
 const refresh=page.getByRole('button',{name:'更新',exact:true});await refresh.click();await expect.poll(()=>streams).toBe(1);expect(reads).toBe(1);
 mode='reset';await refresh.click();await expect.poll(()=>reads).toBe(2);await expect(page.locator('#connection')).toContainText('履歴の連続性');
 mode='snapshot';await refresh.click();await expect.poll(()=>reads).toBe(3);
 mode='oversize';await refresh.click();await expect(page.locator('#connection')).toContainText('接続が切れ');await expect(page.locator('#detail h2')).toHaveCount(0);await expect(page.locator('#objective')).toHaveValue('まだ送信していない依頼');
 mode='heartbeat';await refresh.click();await expect(page.locator('#detail h2')).toHaveText('Task one');await expect(page.locator('#objective')).toHaveValue('まだ送信していない依頼');
 denied=true;await refresh.click();await expect(page.locator('#pairing')).toBeVisible();await expect(page.locator('#objective')).toHaveValue('');expect(methods.every(m=>m==='GET')).toBe(true);
});
test('popstateとreloadはTask・過去Attempt・main選択を現在認可から取得し直す',async({page})=>{
 const requests:string[]=[];let denied=false;
 await page.route('https://observer.test/**',async route=>{
  const url=new URL(route.request().url());requests.push(url.pathname+url.search);if(url.pathname==='/'){await route.fulfill(observerDashboardPage());return;}
  if(denied){await route.fulfill({status:401,body:'{}'});return;}
  const task={task_id:'task_one',state:'running',worker_status:'running',updated_at:'now'};
  const value=url.pathname==='/api/session'?{csrf:'csrf',capabilities:['tasks:read','conversations:main:read']}:url.pathname==='/api/tasks'?{items:[task],next:null}:url.pathname==='/api/conversations/main'?{items:[{name:'dona_main',generation:'past',connected:false}]}:url.pathname.startsWith('/api/conversations/main/')?{status:'not_started'}:{snapshot:{task,selected_attempt_id:url.searchParams.get('attempt')??'new',attempts:[{attempt_id:'old',number:1,status:'completed'},{attempt_id:'new',number:2,status:'running'}]},runtime:{status:'not_started'}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://observer.test/');await page.locator('[data-task="task_one"]').click();await page.getByRole('button',{name:'Attempt 1 · 完了'}).click();await expect(page).toHaveURL(/attempt=old/);
 await page.locator('[data-main="dona_main:past"]').click();await expect(page.locator('#detail h2')).toHaveText('Dona本体の会話');
 const before=requests.length;await page.goBack();await expect(page.getByRole('button',{name:'Attempt 1 · 完了'})).toHaveAttribute('aria-pressed','true');expect(requests.slice(before)).toContain('/api/tasks/task_one?attempt=old');
 await page.reload();await expect(page.getByRole('button',{name:'Attempt 1 · 完了'})).toHaveAttribute('aria-pressed','true');
 denied=true;await page.goForward();await expect(page.locator('#detail')).not.toContainText('Dona本体の会話');await expect(page.locator('#pairing')).toBeVisible();
});
