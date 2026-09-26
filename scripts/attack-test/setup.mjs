// Creates the throwaway identities on the LOCAL stack and writes identities.json.
import fs from 'node:fs';
import { adminApi, http, signIn, enrollAndVerify, jwtClaims, ID_FILE } from './lib.mjs';

const PASSWORD = 'Attack-Test-Local-1';
const spec = [
  { key: 'admin_aal2', email: 'attack-admin-aal2@attack.test', name: 'Attack Admin (aal2)', role: 'admin' },
  { key: 'admin_aal1', email: 'attack-admin-aal1@attack.test', name: 'Attack Admin (aal1)', role: 'admin' },
  { key: 'user', email: 'attack-user@attack.test', name: 'Attack Counter User', role: 'user' },
  { key: 'user_off', email: 'attack-user-off@attack.test', name: 'Attack Deactivated User', role: 'user' },
];

const out = { password: PASSWORD, ids: {} };
for (const s of spec) {
  const c = await adminApi('POST', '/auth/v1/admin/users', { email: s.email, password: PASSWORD, email_confirm: true });
  let userId = c.json?.id;
  if (!userId) {
    const l = await adminApi('GET', '/auth/v1/admin/users?per_page=200');
    userId = l.json.users.find((u) => u.email === s.email)?.id;
    if (!userId) throw new Error('cannot create ' + s.email + ' ' + c.text);
    await adminApi('PUT', `/auth/v1/admin/users/${userId}`, { password: PASSWORD });
  }
  const up = await http('POST', '/rest/v1/app_users?on_conflict=user_id', {
    token: (await import('./lib.mjs')).SECRET, apikey: (await import('./lib.mjs')).SECRET,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: { user_id: userId, email: s.email, name: s.name, role: s.role, is_active: true },
  });
  if (up.status >= 300) throw new Error('app_users upsert ' + s.email + ' ' + up.status + ' ' + up.text);
  out.ids[s.key] = { ...s, userId };
}

// admin_aal2: sign in (aal1), enrol + verify TOTP -> aal2 token
{
  const i = out.ids.admin_aal2;
  const s1 = await signIn(i.email, PASSWORD);
  const e = await enrollAndVerify(s1.access_token);
  i.totpSecret = e.secret; i.factorId = e.factorId;
  i.token = e.session.access_token; i.refresh = e.session.refresh_token;
  i.claims = { aal: jwtClaims(i.token).aal };
}
// admin_aal1: has a VERIFIED factor (like a real owner) but this session never passed it
{
  const i = out.ids.admin_aal1;
  const s1 = await signIn(i.email, PASSWORD);
  const e = await enrollAndVerify(s1.access_token);
  i.totpSecret = e.secret; i.factorId = e.factorId;
  const s2 = await signIn(i.email, PASSWORD);
  i.token = s2.access_token; i.refresh = s2.refresh_token;
  i.claims = { aal: jwtClaims(i.token).aal };
}
// user
{
  const i = out.ids.user;
  const s = await signIn(i.email, PASSWORD);
  i.token = s.access_token; i.refresh = s.refresh_token; i.claims = { aal: jwtClaims(i.token).aal };
}
// deactivated user: take a live token first, THEN deactivate (the worst case: a token still inside its 1h life)
{
  const i = out.ids.user_off;
  const s = await signIn(i.email, PASSWORD);
  i.token = s.access_token; i.refresh = s.refresh_token; i.claims = { aal: jwtClaims(i.token).aal };
  const { SECRET } = await import('./lib.mjs');
  const r = await http('PATCH', `/rest/v1/app_users?user_id=eq.${i.userId}`, { token: SECRET, apikey: SECRET, headers: { Prefer: 'return=representation' }, body: { is_active: false } });
  if (r.status >= 300 || !r.json?.length) throw new Error('deactivate failed ' + r.text);
}
out.ids.anon = { key: 'anon', email: null, role: null, token: null };
out.createdAt = Date.now();
fs.writeFileSync(ID_FILE, JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out.ids)) console.log(k.padEnd(11), v.userId ?? '-', v.claims?.aal ?? '-');
