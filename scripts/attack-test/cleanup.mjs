import { http, SECRET } from './lib.mjs';
import * as fx from './fx.mjs';
// every attack-* / ctl-* / invite account except the demo owner: is_active=false (never delete)
const emails = fx.rows(`select user_id, email from app_users where (email like 'attack-%' or email like 'ctl-%') and is_active`);
for (const u of emails) {
  const r = await http('PATCH', `/rest/v1/app_users?user_id=eq.${u.user_id}`, { token: SECRET, apikey: SECRET, headers: { Prefer: 'return=representation' }, body: { is_active: false } });
  console.log(u.email, r.status, r.json?.[0]?.is_active);
}
console.log(fx.sql(`select email||' role='||role||' active='||is_active from app_users order by email`));
