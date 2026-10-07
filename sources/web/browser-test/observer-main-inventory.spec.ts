import {test,expect} from '@playwright/test';
import {observerDashboardPage} from '../src/observer-dashboard.js';

test('本体一覧の503でもTaskを表示し、復旧と失効を区別する',async({page})=>{
 let mainStatus=503,taskReads=0;
 const task={task_id:'task_one',task_key:'永続Task',state:'running',worker_status:'running',updated_at:'2026-10-05T07:00:00Z'};
 await page.route('https://observer.test/**',async route=>{
  const p=new URL(route.request().url()).pathname;
  if(p==='/'){await route.fulfill(observerDashboardPage());return;}
  if(p==='/api/conversations/main'&&mainStatus!==200){await route.fulfill({status:mainStatus,body:'{}'});return;}
  if(p==='/api/tasks')taskReads++;
  const value=p==='/api/session'?{csrf:'csrf',capabilities:['tasks:read','conversations:main:read']}:p==='/api/tasks'?{items:[task],next:null}:p==='/api/conversations/main'?{items:[{name:'main',generation:'g',state:'idle',connected:true}]}:p.startsWith('/api/conversations/main/')?{status:'observed',conversation:{name:'main',generation:'g',state:'idle',items:[{id:'private',kind:'assistant_message',text:'本体の非公開会話'}]}}:{snapshot:{task,attempts:[],request:'Taskの依頼'},runtime:{status:'unavailable'}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://observer.test/');
 await expect(page.locator('[data-task="task_one"]')).toBeVisible();await expect(page.locator('#main-conversations')).toContainText('現在取得できません');
 await page.locator('[data-task="task_one"]').click();await expect(page.locator('#detail')).toContainText('Taskの依頼');
 await page.getByRole('button',{name:'更新',exact:true}).click();await expect(page.locator('#detail')).toContainText('Taskの依頼');
 mainStatus=200;await page.getByRole('button',{name:'更新',exact:true}).click();await expect(page.locator('[data-main="main:g"]')).toBeVisible();
 await page.locator('[data-main="main:g"]').click();await expect(page.locator('#detail')).toContainText('本体の非公開会話');
 mainStatus=503;await page.getByRole('button',{name:'更新',exact:true}).click();
 await expect(page.locator('#detail')).toContainText('現在取得できません');await expect(page.locator('#detail')).not.toContainText('本体の非公開会話');await expect(page.locator('[data-task="task_one"]')).toBeVisible();
 mainStatus=200;await page.getByRole('button',{name:'更新',exact:true}).click();await expect(page.locator('#detail')).toContainText('本体の非公開会話');
 const readsBeforeRevoke=taskReads;mainStatus=401;await page.getByRole('button',{name:'更新',exact:true}).click();
 await expect(page.locator('#detail')).toContainText('認証が必要');await expect(page.locator('[data-task]')).toHaveCount(0);await expect(page.locator('[data-main]')).toHaveCount(0);expect(taskReads).toBe(readsBeforeRevoke);
});

test('古い本体一覧の遅延失敗で新しいTask選択を消去しない',async({page})=>{
 let hold=false,entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>release=resolve);
 const task={task_id:'task_one',task_key:'選択先Task',state:'running',worker_status:'running'};
 await page.route('https://observer.test/**',async route=>{
  const p=new URL(route.request().url()).pathname;
  if(p==='/'){await route.fulfill(observerDashboardPage());return;}
  if(p==='/api/conversations/main'&&hold){entered();await waiting;await route.fulfill({status:503,body:'{}'});return;}
  const value=p==='/api/session'?{csrf:'csrf',capabilities:['tasks:read','conversations:main:read']}:p==='/api/tasks'?{items:[task],next:null}:p==='/api/conversations/main'?{items:[]}:{snapshot:{task,attempts:[],request:'新しい選択の依頼'},runtime:{status:'unavailable'}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://observer.test/');await expect(page.locator('[data-task="task_one"]')).toBeVisible();
 hold=true;await page.getByRole('button',{name:'更新',exact:true}).click();await started;
 await page.locator('[data-task="task_one"]').click();await expect(page.locator('#detail')).toContainText('新しい選択の依頼');
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/conversations/main'&&r.status()===503);release();await response;
 await expect(page.locator('#detail')).toContainText('新しい選択の依頼');await expect(page.locator('[data-task="task_one"]')).toHaveAttribute('aria-pressed','true');
});

for(const stream of [false,true])test('本体'+(stream?'SSE':'詳細')+'の障害でもTaskを維持し失効時だけ全消去する',async({page})=>{
 let failure=0,taskReads=0;
 const task={task_id:'task_one',task_key:'稼働Task',state:'running',worker_status:'running'};
 await page.route('https://observer.test/**',async route=>{
  const p=new URL(route.request().url()).pathname;
  if(p==='/'){await route.fulfill(observerDashboardPage());return;}
  if(p.startsWith('/api/conversations/main/main/')&&failure){await route.fulfill({status:failure,body:'{}'});return;}
  if(p==='/api/tasks')taskReads++;
  const value=p==='/api/session'?{csrf:'csrf',capabilities:['tasks:read','conversations:main:read']}:p==='/api/tasks'?{items:[task],next:null}:p==='/api/conversations/main'?{items:[{name:'main',generation:'g',state:'idle',connected:true}]}:{status:'observed',...(stream?{stream_cursor:'cursor'}:{}),conversation:{name:'main',generation:'g',state:'idle',items:[{id:'private',kind:'assistant_message',text:'本体の会話本文'}]}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://observer.test/');await page.locator('[data-main="main:g"]').click();await expect(page.locator('#detail')).toContainText('本体の会話本文');
 failure=503;const before=taskReads;await page.getByRole('button',{name:'更新',exact:true}).click();
 await expect(page.locator('#detail')).toContainText('現在取得できません');await expect(page.locator('#detail')).not.toContainText('本体の会話本文');await expect(page.locator('[data-task="task_one"]')).toBeVisible();expect(taskReads).toBeGreaterThan(before);
 failure=0;await page.getByRole('button',{name:'更新',exact:true}).click();await expect(page.locator('#detail')).toContainText('本体の会話本文');
 failure=401;await page.getByRole('button',{name:'更新',exact:true}).click();await expect(page.locator('#detail')).toContainText('認証が必要');await expect(page.locator('[data-task]')).toHaveCount(0);
});
