import assert from "node:assert/strict";
import {test} from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import {DashboardServer} from "../src/dashboard/server.js";
import type {DashboardTaskReader} from "../src/dashboard/task-reader.js";
import type {DashboardObserver} from "../src/dashboard/observer.js";
async function freePort(){const s=net.createServer();await new Promise<void>(resolve=>s.listen(0,"127.0.0.1",resolve));const port=(s.address() as net.AddressInfo).port;await new Promise<void>(resolve=>s.close(()=>resolve()));return port;}
async function request(port:number,socket:string|null,target:string,options:{method?:string;body?:unknown;cookie?:string;origin?:string;host?:string;csrf?:string}={}){
  return await new Promise<{status:number;body:string;headers:http.IncomingHttpHeaders}>((resolve,reject)=>{
    const body=options.body===undefined?"":JSON.stringify(options.body);
    const req=http.request({...(socket?{socketPath:socket}:{hostname:"127.0.0.1",port}),path:target,method:options.method??"GET",headers:{host:options.host??"observer.example",...(options.origin?{origin:options.origin}:{}),...(options.cookie?{cookie:options.cookie}:{}),...(options.csrf?{"x-csrf-token":options.csrf}:{}),...(options.method==="POST"?{"content-type":"application/json","content-length":Buffer.byteLength(body)}:{})}},res=>{
      let text="";res.setEncoding("utf8");res.on("data",x=>text+=x);res.on("end",()=>resolve({status:res.statusCode!,body:text,headers:res.headers}));
    });req.on("error",reject);req.end(body);
  });
}
test("private controlの一回限りcodeで登録し、cross-origin・未認証・失効sessionを拒否する",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dobs-"));await fs.chmod(root,0o700);
  const socket=path.join(await fs.realpath(root),"c.sock"),port=await freePort();let reads=0;
  const server=new DashboardServer({origin:"https://observer.example",port,controlSocket:socket,version:"test",
    page:{status:200,headers:{},body:"<html>observer</html>"},reader:{list(){reads++;return {items:[],next:null};}} as unknown as DashboardTaskReader,
    observer:{} as DashboardObserver});
  try{
    await server.start();
    assert.equal((await request(port,null,"/api/tasks")).status,401);
    assert.equal(reads,0);
    const pair=JSON.parse((await request(port,socket,"/pair",{method:"POST"})).body);
    assert.equal((await request(port,null,"/api/pair",{method:"POST",body:{code:pair.code},origin:"https://evil.example"})).status,403);
    const login=await request(port,null,"/api/pair",{method:"POST",body:{code:pair.code},origin:"https://observer.example"});
    assert.equal(login.status,200);const cookie=login.headers["set-cookie"]![0]!.split(";")[0]!;
    assert.match(login.headers["set-cookie"]![0]!,/Secure; SameSite=Strict/);
    assert.equal((await request(port,null,"/api/pair",{method:"POST",body:{code:pair.code},origin:"https://observer.example"})).status,403);
    assert.equal((await request(port,null,"/api/tasks",{cookie})).status,200);assert.equal(reads,1);
    assert.equal((await request(port,null,"/api/tasks",{cookie,host:"attacker.example"})).status,403);
    assert.equal((await request(port,null,"/api/logout",{method:"POST",cookie,origin:"https://observer.example"})).status,403);
    await request(port,socket,"/revoke",{method:"POST"});
    assert.equal((await request(port,null,"/api/tasks",{cookie})).status,401);
    assert.equal((await fs.stat(socket)).mode&0o777,0o600);
    assert.equal((await request(port,socket,"/health/version")).status,200);
    assert.equal(reads,1);
  }finally{await server.close();await fs.rm(root,{recursive:true,force:true});}
});

test("service再起動でcookieを失効し、実Taskの継続とsnapshotを維持する",async()=>{
  const {DispatcherDatabase}=await import("../src/database.js");
  const {DashboardTaskReader}=await import("../src/dashboard/task-reader.js");
  const {DashboardObserver}=await import("../src/dashboard/observer.js");
  const {taskRequestSchema}=await import("../src/task-execution.js");
  const {tempConfig,eventEnvelope}=await import("./helpers.js");
  const {root,config}=await tempConfig();const db=new DispatcherDatabase(config.databasePath);
  const parent=path.join(await fs.realpath(root),"observer");await fs.mkdir(parent,{mode:0o700});
  const socket=path.join(parent,"c.sock"),port=await freePort();
  const event=db.enqueue(eventEnvelope("observer-service")).row;
  const task=db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:"service-observation",objective:"observe",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
  const reader=new DashboardTaskReader(config.databasePath);const before=db.tasks.get(task.task_id);
  let runtimeReads=0;
  const runtime={async conversations(){runtimeReads++;return {items:[],next:null};},async conversation(){throw Error("unexpected history");}};
  const options={origin:"https://observer.example",port,controlSocket:socket,version:"test",page:{status:200,headers:{},body:"observer"},reader,observer:new DashboardObserver(reader,runtime)};
  let server=new DashboardServer(options);
  try{
    await server.start();const code=JSON.parse((await request(port,socket,"/pair",{method:"POST"})).body).code;
    const paired=await request(port,null,"/api/pair",{method:"POST",body:{code},origin:options.origin});
    const cookie=paired.headers["set-cookie"]![0]!.split(";")[0]!;
    const detail=await request(port,null,`/api/tasks/${task.task_id}`,{cookie});assert.equal(detail.status,200);
    assert.equal(JSON.parse(detail.body).snapshot.task.current_attempt_id,task.current_attempt_id);assert.equal(runtimeReads,1);
    assert.deepEqual(db.tasks.get(task.task_id),before);
    await server.close();server=new DashboardServer(options);await server.start();
    assert.equal((await request(port,null,"/api/tasks",{cookie})).status,401);
    assert.deepEqual(db.tasks.get(task.task_id),before);
    assert.equal(runtimeReads,1);
  }finally{await server.close();reader.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});
