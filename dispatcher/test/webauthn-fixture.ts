import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
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
export function authenticator(){
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
