import {serveRuntime} from "../../src/app-server/host.js";

// test親だけが管理するhost。production設定やservice管理には接続しない。
const [socket,database,codex]=process.argv.slice(2);
if(!socket||!database||!codex||!process.send)throw Error("fixture_arguments_missing");
await serveRuntime({socket,database,codex,buildSha:"worker-handoff-fixture"});
process.send({ready:true});
