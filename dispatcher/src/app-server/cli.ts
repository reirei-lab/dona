#!/usr/bin/env node
import fs from "node:fs";
import {serveRuntime,type HostConfig} from "./host.js";

const file=process.argv[2];
if(!file)throw Error("runtime_config_required");
const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o022))throw Error("runtime_config_unsafe");
const config=JSON.parse(fs.readFileSync(file,"utf8")) as HostConfig;
const server=await serveRuntime(config);
// hostの停止だけでworker停止を主張しない。更新側は先に各agentのstop receiptを確認する。
for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5_000).unref();});
