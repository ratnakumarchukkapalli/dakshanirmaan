import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadIdentities, URL_, PUB, OUT, REPO } from './lib.mjs';
const ROOT=REPO; const APP='http://127.0.0.1:3100';
const require=createRequire(`${ROOT}/package.json`); const {createServerClient}=require('@supabase/ssr');
const ids=loadIdentities().ids;
async function cookieFor(k){const i=ids[k];const jar=new Map();const sb=createServerClient(URL_,PUB,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:cs=>cs.forEach(({name,value})=>jar.set(name,value))}});await sb.auth.setSession({access_token:i.token,refresh_token:i.refresh});return [...jar].map(([n,v])=>`${n}=${v}`).join('; ');}
const man=JSON.parse(fs.readFileSync(`${ROOT}/.next/server/server-reference-manifest.json`,'utf8')).node;
const byName=Object.fromEntries(Object.entries(man).map(([id,v])=>[v.exportedName,{id,pages:Object.keys(v.workers)}]));
const call=async(who,name,path)=>{const r=await fetch(APP+path,{method:'POST',redirect:'manual',headers:{cookie:await cookieFor(who),'Content-Type':'text/plain;charset=UTF-8',Accept:'text/x-component','Next-Action':byName[name].id,Origin:APP},body:'[{}]'});return `${r.status} ${(await r.text()).slice(0,70).replace(/\s+/g,' ')}`;};
for (const n of ['inviteUser','setPeriodLock','cancelInvoice','recordTransfer']) {
  console.log(n, 'workers:', byName[n].pages.map(p=>p.replace('app/(app)','')).join(', '));
  console.log('   owner  own page   :', await call('admin_aal2', n, '/'+byName[n].pages[0].replace(/^app\//,'').replace(/\/page$/,'').replace(/\([^)]*\)\/?/g,'').replace(/\[[^\]]+\]/g,'00000000-0000-4000-8000-000000000000')));
  console.log('   owner  posted to / :', await call('admin_aal2', n, '/'));
  console.log('   user   posted to / :', await call('user', n, '/'));
}
// how many owner-only actions did the counter reach the gate on?
const s=JSON.parse(fs.readFileSync(OUT + '/actions-summary.json','utf8'));
const OWN=new Set(['inviteUser','disableUser','enableUser','resetUserPassword','addOpeningPartyLine','addOpeningMoneyLine','addOpeningStockLine','removeOpeningLine','importOpeningStock','postOpening','cancelOpening','reopenDay','createItem','updateItem','deactivateItem','reactivateItem','updateOrganization','bounceCheque','cancelPayment','cancelInvoice','setPeriodLock','createFiscalYear','recordAdvance','recordSalary','recordWages','createEmployee','updateEmployee','recordAdjustment','recordTransfer','receiveTransfer']);
const rows=s.filter(r=>OWN.has(r.action.split(':')[1]));
console.log('owner-only actions:',rows.length,'| user got code:forbidden (gate exercised):',rows.filter(r=>r.user==='code:forbidden').length,'| user redirected by proxy (URL-level only):',rows.filter(r=>r.user.startsWith('307')).length,'| other:',rows.filter(r=>r.user!=='code:forbidden'&&!r.user.startsWith('307')).map(r=>r.action+'='+r.user));
console.log('gate-exercised:', rows.filter(r=>r.user==='code:forbidden').map(r=>r.action.split(':')[1]).join(', '));
console.log('proxy-only   :', rows.filter(r=>r.user.startsWith('307')).map(r=>r.action.split(':')[1]).join(', '));
