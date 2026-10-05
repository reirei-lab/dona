import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { DispatcherDatabase } from "../src/database.js";
import { taskRequestSchema } from "../src/task-execution.js";
import { DashboardObserver, type ConversationContent, type DashboardAuthority } from "../src/dashboard/observer.js";
import { DashboardTaskReader } from "../src/dashboard/task-reader.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

test("観測readerは非公開Taskを除いてからpageを作り、実行DBを変更しない", async () => {
  const {root, config} = await tempConfig();
  const db = new DispatcherDatabase(config.databasePath);
  let reader: DashboardTaskReader | undefined;
  try {
    const event = db.enqueue(eventEnvelope("dashboard-observation")).row;
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const request = taskRequestSchema.parse({source_event_id:event.event_id,task_key:`observe-${i}`,objective:"secret objective /private/path token",workspace:{kind:"scratch"}});
      ids.push(db.tasks.create(request,config.jobsWorkspaceRoot,config.jobResultsDir).task.task_id);
    }
    ids.sort().reverse();
    reader = new DashboardTaskReader(config.databasePath);
    const before = ids.map(id => db.tasks.get(id));
    const first = reader.list(task => task.task_id !== ids[0],null,2);
    assert.deepEqual(first.items.map(task=>task.task_id),ids.slice(1,3));
    assert.equal(first.next,ids[2]);
    const second = reader.list(task=>task.task_id!==ids[0],first.next,2);
    assert.deepEqual(second.items.map(task=>task.task_id),ids.slice(3));
    assert.equal(second.next,null);
    const snapshot = reader.snapshot(ids[1]!)!;
    assert.equal(snapshot.attempts.length,1);
    assert.equal(snapshot.attempts[0]!.attempt_id,snapshot.task.current_attempt_id);
    assert.equal(JSON.stringify(snapshot).includes("secret objective"),false);
    assert.equal(JSON.stringify(snapshot).includes(config.jobsWorkspaceRoot),false);
    assert.deepEqual(ids.map(id=>db.tasks.get(id)),before);
    assert.throws(()=>reader!.list(()=>true,null,51),/query_invalid/);
    assert.equal(reader.snapshot("unknown"),null);
    assert.throws(()=>new DashboardTaskReader(`${root}/absent.sqlite3`));
  } finally { reader?.close();db.close();await fs.rm(root,{recursive:true,force:true}); }
});

test("会話取得中の失効・Attempt変更は古い本文を返さず、切断をTask失敗にしない", async () => {
  const {root, config} = await tempConfig();
  const db = new DispatcherDatabase(config.databasePath);
  let reader: DashboardTaskReader | undefined;
  try {
    const event = db.enqueue(eventEnvelope("dashboard-races")).row;
    const task = db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:"observe",objective:"観測",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
    reader = new DashboardTaskReader(config.databasePath);
    let authority: DashboardAuthority | null = {revision:"1",task:()=>true,conversation:()=>true};
    const content: ConversationContent = {name:db.getJob(task.current_attempt_id)!.agent_name,generation:"g1",role:"worker",thread_id:"thread",attempt_id:task.current_attempt_id,connected:true,observed_at:new Date().toISOString(),state:"working",items:[],events:[],cursor:1,oldest_sequence:1,gap:false,truncated:false};
    let action = () => {};
    const observer = new DashboardObserver(reader,{async conversations(){return {items:[content],next:null};},async conversation(){action();return content;}});
    (content as unknown as Record<string,unknown>).raw_tool_arguments="private tool input";
    content.items=[{id:"item",turn_id:"turn",kind:"tool_progress",text:"private tool output",status:"completed"}];
    const initial=await observer.detail(task.task_id,()=>authority);
    assert.equal(initial!.runtime.status,"observed");
    assert.equal(JSON.stringify(initial).includes("private tool"),false);
    action=()=>{authority=null;};
    assert.equal(await observer.detail(task.task_id,()=>authority),null);
    authority={revision:"2",task:()=>true,conversation:()=>true};
    action=()=>{db.tasks.wait(db.tasks.get(task.task_id)!,"human_input",1000);};
    const changed=await observer.detail(task.task_id,()=>authority);
    assert.equal(changed!.runtime.status,"unavailable");
    assert.equal(changed!.snapshot.task.wait_reason,"human_input");
    action=()=>{throw Error("network disconnected");};
    const offline=await observer.detail(task.task_id,()=>authority);
    assert.equal(offline!.runtime.status,"unavailable");
    assert.equal(offline!.snapshot.task.state,"waiting");
    authority={revision:"3",task:()=>true,conversation:()=>false};
    assert.equal((await observer.detail(task.task_id,()=>authority))!.runtime.status,"forbidden");
  } finally {reader?.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});
