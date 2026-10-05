import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import Database from 'better-sqlite3';
import {OperatorAuthRegistry} from '../src/dashboard/operator-auth.js';
import {OperatorWebAuthn,type ApprovalIntent} from '../src/dashboard/operator-webauthn.js';
import type {RegistrationResponseJSON,AuthenticationResponseJSON} from '@simplewebauthn/server';
const origin='https://dona.example.test',rpID='dona.example.test';
const hash=(input:string|Buffer)=>createHash('sha256').update(input).digest();
const b64=(input:Buffer)=>input.toString('base64url');
// Minimal deterministic CBOR encoder for a real ES256 authenticator fixture.
function cbor(value:unknown):Buffer {
 const head=(major:number,n:number)=>n<24?Buffer.from([(major<<5)|n]):n<256?Buffer.from([(major<<5)|24,n]):Buffer.from([(major<<5)|25,n>>8,n&255]);
 if(typeof value==='number')return value>=0?head(0,value):head(1,-1-value);
 if(typeof value==='string'){const bytes=Buffer.from(value);return Buffer.concat([head(3,bytes.length),bytes]);}
 if(Buffer.isBuffer(value))return Buffer.concat([head(2,value.length),value]);
 if(value instanceof Map)return Buffer.concat([head(5,value.size),...Array.from(value.entries()).flatMap(([k,v])=>[cbor(k),cbor(v)])]);
 throw Error('fixture_cbor_invalid');
}
function authenticator(){
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=keys.publicKey.export({format:'jwk'}),id=randomBytes(32);
 const publicKey=cbor(new Map<unknown,unknown>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]));
 const data=(flags:number,counter:number)=>{const count=Buffer.alloc(4);count.writeUInt32BE(counter);return Buffer.concat([hash(rpID),Buffer.from([flags]),count]);};
 return {
  register(challenge:string,opts:{origin?:string;uv?:boolean}={}):RegistrationResponseJSON {
   const client=Buffer.from(JSON.stringify({type:'webauthn.create',challenge,origin:opts.origin??origin,crossOrigin:false}));
   const size=Buffer.alloc(2);size.writeUInt16BE(id.length);
   const authData=Buffer.concat([data(opts.uv===false?0x41:0x45,0),Buffer.alloc(16),size,id,publicKey]);
   const attestation=cbor(new Map<unknown,unknown>([['fmt','none'],['attStmt',new Map()],['authData',authData]]));
   return {id:b64(id),rawId:b64(id),type:'public-key',clientExtensionResults:{},response:{clientDataJSON:b64(client),attestationObject:b64(attestation),transports:['internal']}};
  },
  assert(challenge:string,opts:{origin?:string;uv?:boolean;counter?:number}={}):AuthenticationResponseJSON {
   const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge,origin:opts.origin??origin,crossOrigin:false})),authData=data(opts.uv===false?0x01:0x05,opts.counter??1);
   const signature=sign('sha256',Buffer.concat([authData,hash(client)]),keys.privateKey);
   return {id:b64(id),rawId:b64(id),type:'public-key',clientExtensionResults:{},response:{clientDataJSON:b64(client),authenticatorData:b64(authData),signature:b64(signature)}};
  }
 };
}
function fixture(){
 const sql=new Database(':memory:');let elapsed=0;const epoch=Date.now(),clock=()=>elapsed;
 const auth=new OperatorAuthRegistry(sql,clock,()=>new Date(epoch+elapsed));
 const paired=auth.pair(auth.issueCode(['tasks:read','approvals:native','approvals:external']).code);
 const web=new OperatorWebAuthn(sql,auth,origin,clock,()=>epoch+elapsed),device=authenticator();
 const intent:ApprovalIntent={request_id:'approval_one',decision:'approve',presentation_digest:'a'.repeat(64),expires_at:new Date(epoch+600000).toISOString()};
 return {sql,auth,web,device,token:paired.token,session:paired.session,intent,advance:(ms:number)=>{elapsed+=ms;}};
}
async function enroll(f:ReturnType<typeof fixture>){const options=await f.web.registrationOptions(f.token);await f.web.register(f.token,options.ceremony_id,f.device.register(options.options.challenge));}

test('実ES256/CBOR登録と署名assertionを通し別action・capability・replayを拒否する',async()=>{
 const f=fixture();try{
  assert.deepEqual(f.web.status(f.token),{registered:false,can_enroll:true});await enroll(f);assert.equal(f.web.status(f.token).registered,true);
  const ceremony=await f.web.approvalOptions(f.token,'approvals:native',f.intent),response=f.device.assert(ceremony.options.challenge);
  const receipt=await f.web.verify(f.token,ceremony.ceremony_id,response);
  assert.equal(f.web.verifyReceipt(receipt,f.intent,'approvals:native'),true);
  assert.equal(f.web.verifyReceipt(receipt,{...f.intent,decision:'reject'},'approvals:native'),false);
  assert.equal(f.web.verifyReceipt(receipt,{...f.intent,request_id:'other'},'approvals:native'),false);
  assert.equal(f.web.verifyReceipt(receipt,{...f.intent,presentation_digest:'b'.repeat(64)},'approvals:native'),false);
  assert.equal(f.web.verifyReceipt(receipt,f.intent,'approvals:external'),false);
  await assert.rejects(f.web.verify(f.token,ceremony.ceremony_id,response));
  f.auth.revoke(f.session.device_id);assert.equal(f.web.verifyReceipt(receipt,f.intent,'approvals:native'),false);
 }finally{f.sql.close();}
});

test('登録と承認のwrong origin・UVなしは実verificationで拒否する',async()=>{
 const f=fixture();try{
  for(const opts of [{origin:'https://evil.example'},{uv:false}]){
   const c=await f.web.registrationOptions(f.token);await assert.rejects(f.web.register(f.token,c.ceremony_id,f.device.register(c.options.challenge,opts)));assert.equal(f.web.status(f.token).registered,false);
  }
  await enroll(f);
  for(const opts of [{origin:'https://evil.example'},{uv:false}]){
   const c=await f.web.approvalOptions(f.token,'approvals:native',f.intent);await assert.rejects(f.web.verify(f.token,c.ceremony_id,f.device.assert(c.options.challenge,opts)));
  }
 }finally{f.sql.close();}
});

test('current grant失効・ceremony期限・backend再起動で署名済みproofも拒否する',async()=>{
 const f=fixture();try{
  await enroll(f);const c=await f.web.approvalOptions(f.token,'approvals:native',f.intent),response=f.device.assert(c.options.challenge);
  const reboot=new OperatorWebAuthn(f.sql,f.auth,origin);await assert.rejects(reboot.verify(f.token,c.ceremony_id,response));
  f.advance(120001);await assert.rejects(f.web.verify(f.token,c.ceremony_id,response));
  const next=await f.web.approvalOptions(f.token,'approvals:native',f.intent);f.auth.revoke(f.session.device_id);
  await assert.rejects(f.web.verify(f.token,next.ceremony_id,f.device.assert(next.options.challenge)));
 }finally{f.sql.close();}
});

test('並列署名検証は一度だけ受理しcounter競合を上書きしない',async()=>{
 const f=fixture();try{
  await enroll(f);const c=await f.web.approvalOptions(f.token,'approvals:native',f.intent),response=f.device.assert(c.options.challenge);
  const results=await Promise.allSettled([f.web.verify(f.token,c.ceremony_id,response),f.web.verify(f.token,c.ceremony_id,response)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const next=await f.web.approvalOptions(f.token,'approvals:native',f.intent);
  const pending=f.web.verify(f.token,next.ceremony_id,f.device.assert(next.options.challenge,{counter:2}));
  f.sql.prepare('UPDATE dashboard_operator_credentials SET counter=10 WHERE device_id=?').run(f.session.device_id);
  await assert.rejects(pending);assert.equal((f.sql.prepare('SELECT counter FROM dashboard_operator_credentials').get() as {counter:number}).counter,10);
 }finally{f.sql.close();}
});


test('別challengeと改変署名を拒否し登録ceremonyも再利用できない',async()=>{
 const f=fixture();try{
  const registration=await f.web.registrationOptions(f.token),registered=f.device.register(registration.options.challenge);
  await f.web.register(f.token,registration.ceremony_id,registered);await assert.rejects(f.web.register(f.token,registration.ceremony_id,registered));
  const ceremony=await f.web.approvalOptions(f.token,'approvals:native',f.intent);
  await assert.rejects(f.web.verify(f.token,ceremony.ceremony_id,f.device.assert(b64(randomBytes(32)))));
  const proof=f.device.assert(ceremony.options.challenge),signature=Buffer.from(proof.response.signature,'base64url');signature[signature.length-1]=signature[signature.length-1]!^1;proof.response.signature=b64(signature);
  await assert.rejects(f.web.verify(f.token,ceremony.ceremony_id,proof));
  assert.equal((f.sql.prepare('SELECT counter FROM dashboard_operator_credentials').get() as {counter:number}).counter,0);
 }finally{f.sql.close();}
});
