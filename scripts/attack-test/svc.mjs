import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadIdentities, URL_, PUB, adminApi, http, record, saveResults, OUT, REPO } from './lib.mjs';
import * as fx from './fx.mjs';
const ROOT=REPO; const APP='http://127.0.0.1:3100';
const require=createRequire(`${ROOT}/package.json`); const {createServerClient}=require('@supabase/ssr');
const {ids,password}=loadIdentities();
async function cookieFor(k){const i=ids[k];const jar=new Map();const sb=createServerClient(URL_,PUB,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:cs=>cs.forEach(({name,value})=>jar.set(name,value))}});await sb.auth.setSession({access_token:i.token,refresh_token:i.refresh});return [...jar].map(([n,v])=>`${n}=${v}`).join('; ');}
const man=JSON.parse(fs.readFileSync(`${ROOT}/.next/server/server-reference-manifest.json`,'utf8')).node;
const byName=Object.fromEntries(Object.entries(man).map(([id,v])=>[v.exportedName,id]));
const call=async(who,name,path,args)=>{const r=await fetch(APP+path,{method:'POST',redirect:'manual',headers:{cookie:await cookieFor(who),'Content-Type':'text/plain;charset=UTF-8',Accept:'text/x-component','Next-Action':byName[name],Origin:APP},body:JSON.stringify([args])});const t=await r.text();return {status:r.status,code:/"code":"([a-z_]+)"/.exec(t)?.[1],ok:/"ok":true/.test(t),raw:t.slice(0,120).replace(/\s+/g,' ')};};
const authUsers=async()=> (await adminApi('GET','/auth/v1/admin/users?per_page=200')).json.users.map(u=>u.email);
const out=[]; const T=(id,title,actual,bad,spec)=>{const r={identity:'user',object:id,op:'ACTION',variant:title,actual,verdict:bad?'FAIL':'PASS',spec,expected:'refused, no side effect',req:'server action POST with VALID args, session cookie of user'};out.push(r);record(r);console.log(r.verdict,id,title,'=>',actual);};
const owner=ids.admin_aal2; const inviteEmail=`attack-invite-${Date.now()}@attack.test`;
for (const path of ['/','/parties','/sales']) {
  const before=await authUsers();
  const r=await call('user','inviteUser',path,{email:inviteEmail+path.replace('/','x'),name:'ATTACK',role:'admin',password:'Attack-Test-Local-1'});
  const after=await authUsers();
  T('S1',`inviteUser(role admin) as user, posted to ${path}`,`${r.status} ${r.code??''} ${r.ok?'ok:true':''} ${r.raw.slice(0,60)}; auth users ${before.length}->${after.length}`, r.ok || after.length>before.length,'api-architecture: user management is owner-only; service key must never be reachable by a counter session');
}
for (const path of ['/','/parties']) {
  const r=await call('user','resetUserPassword',path,{userId:owner.userId,password:'Hacked-Pass-123'});
  const login=await http('POST','/auth/v1/token?grant_type=password',{body:{email:owner.email,password:'Hacked-Pass-123'}});
  T('S2',`resetUserPassword(owner, new password) as user, posted to ${path}`,`${r.status} ${r.code??''}${r.ok?' ok:true':''}; sign-in as owner with the new password => ${login.status}`, r.ok||login.status===200,'account takeover of the owner');
}
for (const [name,path] of [['disableUser','/'],['enableUser','/parties']]) {
  const r=await call('user',name,path,{userId:name==='disableUser'?owner.userId:ids.user_off.userId});
  const st=fx.sql(`select email||':'||is_active from app_users where user_id in ('${owner.userId}','${ids.user_off.userId}') order by email`).replace(/\n/g,' ; ');
  T('S3',`${name} as user (target ${name==='disableUser'?'owner':'deactivated user'}), posted to ${path}`,`${r.status} ${r.code??''}${r.ok?' ok:true':''}; app_users now ${st}`, r.ok || (name==='disableUser'&&/aal2@attack.test:false/.test(st)) || (name==='enableUser'&&/user-off@attack.test:true/.test(st)),'owner-only');
}
// control: the owner can do the same (proves the arguments are valid)
{
  const r=await call('admin_aal2','inviteUser','/',{email:`ctl-${Date.now()}@attack.test`,name:'Control',role:'user',password:'Attack-Test-Local-1'});
  console.log('CONTROL owner inviteUser =>',r.status,r.code??'',r.ok?'ok:true':'',r.raw.slice(0,80));
}
fs.writeFileSync(OUT + '/findings-6.json',JSON.stringify(out,null,1)); saveResults('results-6');
