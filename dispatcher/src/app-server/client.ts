import http from "node:http";
import type {AgentRecord,QuestionRecord} from "./store.js";
import type {StartAgent} from "./manager.js";

export class RuntimeClient {
  constructor(readonly socket:string,private readonly timeoutMs=30_000){}
  call<T>(action:string,params:Record<string,unknown>={}):Promise<T> {
    return new Promise((resolve,reject)=>{
      const body=JSON.stringify({action,...params});
      const request=http.request({socketPath:this.socket,path:"/control",method:"POST",headers:{"content-type":"application/json","content-length":Buffer.byteLength(body)}},response=>{
        let text="";response.setEncoding("utf8");response.on("data",(chunk:string)=>{text+=chunk;if(Buffer.byteLength(text)>2_097_152)response.destroy(Error("runtime_response_limit"));});
        response.on("error",reject);response.on("end",()=>{try{const value=JSON.parse(text) as {result:T;error?:string};if(response.statusCode!==200)throw Error(value.error??"runtime_request_failed");resolve(value.result);}catch(error){reject(error);}});
      });
      request.setTimeout(this.timeoutMs,()=>request.destroy(Error("runtime_response_unknown")));request.on("error",reject);request.end(body);
    });
  }
  status(name:string):Promise<AgentRecord|null>{return this.call("status",{name});}
  list():Promise<AgentRecord[]>{return this.call("list");}
  start(input:StartAgent):Promise<AgentRecord>{return this.call("start",{input});}
  prompt(name:string,key:string,text:string):Promise<{turnId:string}>{return this.call("prompt",{name,key,text});}
  questions(name:string,includeResolved=false):Promise<QuestionRecord[]>{return this.call("questions",{name,includeResolved});}
  answer(name:string,id:string,answers:Record<string,{answers:string[]}>):Promise<QuestionRecord>{return this.call("answer",{name,id,answers});}
  stop(name:string,generation:string):Promise<AgentRecord>{return this.call("stop",{name,generation});}
}
