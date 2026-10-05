import { expect, test, type Page } from "@playwright/test";
import { observerDashboardPage } from "../src/observer-dashboard.js";
const at='2026-10-05T00:00:00.000Z';
const task=(id:string)=>({task_id:id,state:'waiting',worker_status:'running',wait_reason:'human_input',updated_at:at});
const detail=(id:string)=>({snapshot:{task:task(id),attempts:[{number:1,status:'running',outcome:null}]},runtime:{status:'observed',conversation:{connected:false,observed_at:at,gap:true,truncated:false,items:[{kind:'assistant_message',text:'<img src=x onerror=alert(1)> '+id},{kind:'tool_progress',status:'running'}]}}});
async function setup(page:Page,options:{pauseA?:Promise<void>;deny?:()=>boolean}={}) {
  const calls:string[]=[];
  await page.route('https://observer.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;calls.push(route.request().method()+' '+path);
    if(path==='/'){await route.fulfill(observerDashboardPage());return;}
    if(options.deny?.()){await route.fulfill({status:401,contentType:'application/json',body:'{}'});return;}
    let value:unknown;
    if(path==='/api/tasks')value={items:[task('task_a'),task('task_b')],next:null};
    else if(path==='/api/tasks/task_a'){if(options.pauseA)await options.pauseA;value=detail('task_a');}
    else if(path==='/api/tasks/task_b')value=detail('task_b');
    else throw Error('unexpected request '+path);
    await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  });
  await page.goto('https://observer.test/');return calls;
}
test('会話をtext表示し接続状態をTask状態と区別する',async({page})=>{
  const calls=await setup(page);await page.getByRole('button',{name:'task_a · 待機中'}).click();
  await expect(page.locator('#detail')).toContainText('質問への回答待ち');await expect(page.locator('#detail')).toContainText('Runtime接続なし');
  await expect(page.locator('#detail')).toContainText('<img src=x onerror=alert(1)> task_a');await expect(page.locator('#detail img')).toHaveCount(0);
  await expect(page.locator('#detail')).toContainText('履歴の一部');expect(calls.every(c=>c.startsWith('GET'))).toBeTruthy();
});
test('遅いTask A応答が選択済みTask Bを上書きしない',async({page})=>{
  let release!:()=>void;const pauseA=new Promise<void>(r=>release=r);await setup(page,{pauseA});
  await page.getByRole('button',{name:'task_a · 待機中'}).click();await page.getByRole('button',{name:'task_b · 待機中'}).click();
  await expect(page.locator('#detail h2')).toHaveText('task_b');release();await page.waitForTimeout(100);
  await expect(page.locator('#detail h2')).toHaveText('task_b');
});
test('認証失効でprivate表示を消去し接続scopeを示す',async({page})=>{
  let deny=false;await setup(page,{deny:()=>deny});await page.getByRole('button',{name:'task_a · 待機中'}).click();
  await expect(page.locator('#detail')).toContainText('task_a');deny=true;await page.getByRole('button',{name:'更新',exact:true}).click();
  await expect(page.locator('#tasks')).toBeEmpty();await expect(page.locator('#detail')).not.toContainText('task_a');
  await expect(page.locator('#pairing')).toBeVisible();await expect(page.locator('#pairing')).toContainText('すべてのTask');
});
test('mobileとkeyboardで閲覧できpoll後も選択buttonのfocusを維持する',async({page})=>{
  await page.setViewportSize({width:375,height:800});await setup(page);const button=page.getByRole('button',{name:'task_b · 待機中'});
  await button.focus();await page.keyboard.press('Enter');await expect(page.locator('#detail h2')).toHaveText('task_b');
  await page.clock.install();await page.clock.fastForward(5001);await expect(button).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('bfcache復帰時は表示を消して接続を再検証する',async({page})=>{
  let deny=false;await setup(page,{deny:()=>deny});await page.getByRole('button',{name:'task_a · 待機中'}).click();await expect(page.locator('#detail')).toContainText('task_a');
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));deny=true;
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await expect(page.locator('#pairing')).toBeVisible();await expect(page.locator('#detail')).not.toContainText('task_a');
});
