// Next.js layer: pages (proxy), export routes, the signed invoice link, and server actions, as each identity.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { loadIdentities, record, saveResults, URL_, PUB, OUT, REPO } from './lib.mjs';
import * as fx from './fx.mjs';
const { C, one, rows } = fx;

const APP = 'http://127.0.0.1:3100';
const ROOT = REPO;
const require = createRequire(`${ROOT}/package.json`);
const { createServerClient } = require('@supabase/ssr');
const ids = loadIdentities();
if (Date.now() - ids.createdAt > 50 * 60 * 1000) throw new Error('tokens too old; rerun setup.mjs');
const IDS = ids.ids;
const LINK_SECRET = fs.readFileSync(`${ROOT}/.env.local`, 'utf8').match(/^INVOICE_LINK_SECRET=(.*)$/m)?.[1]?.trim();

// ---- real session cookies, written by the app's own @supabase/ssr --------------------------------
async function cookieFor(identity) {
  const i = IDS[identity];
  if (!i.token) return '';
  const jar = new Map();
  const sb = createServerClient(URL_, PUB, { cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (cs) => cs.forEach(({ name, value }) => jar.set(name, value)) } });
  const { error } = await sb.auth.setSession({ access_token: i.token, refresh_token: i.refresh });
  if (error) throw new Error('setSession ' + identity + ' ' + error.message);
  return [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
}
const COOKIE = {};
for (const k of ['admin_aal2', 'admin_aal1', 'user', 'user_off', 'anon']) COOKIE[k] = await cookieFor(k);
const IDENT = ['anon', 'admin_aal1', 'user_off', 'user', 'admin_aal2'];
const get = (identity, path, opts = {}) => fetch(APP + path, { redirect: 'manual', headers: { cookie: COOKIE[identity], ...(opts.headers || {}) }, ...opts });

const out = []; let ran = 0, passed = 0;
function rec(o) { ran++; if (o.verdict === 'PASS') passed++; out.push(o); record(o); if (o.verdict !== 'PASS') console.log(`${o.verdict.padEnd(12)} ${o.identity.padEnd(11)} ${o.object} ${o.variant} => ${o.actual}`); }

// ================================================================================================
// 1. Pages: who is redirected where
// ================================================================================================
const ramana = C.ramana;
const inv = one(`select id from sales_invoices where status='posted' order by created_at limit 1`);
const pages = ['/', '/sales', '/parties', '/payments', '/stock', '/purchases', '/account', '/reports', '/reports/day-close', '/reports/day-book', '/reports/aging', '/reports/stock',
  '/reports/cash-bank', '/reports/pnl', '/reports/balance-sheet', '/reports/trial-balance', '/reports/gst',
  '/settings', '/settings/users', '/settings/period-locks', '/settings/audit-trail', '/settings/cutover', '/settings/organisation', '/settings/items', '/settings/chart-of-accounts',
  '/staff', `/staff/${ramana}`];
const USER_BLOCKED = (p) => p === '/settings' || p.startsWith('/settings/') || p === '/staff' || p.startsWith('/staff/') || p === '/reports/cash-bank';
const ownerBody = {};
for (const p of pages) {
  for (const identity of IDENT) {
    const r = await get(identity, p);
    const loc = r.headers.get('location') ? new URL(r.headers.get('location'), APP).pathname : '';
    const body = r.status === 200 ? await r.text() : '';
    if (identity === 'admin_aal2') ownerBody[p] = body;
    let expected, verdict;
    if (identity === 'anon' || identity === 'user_off') { expected = 'redirect /login'; verdict = r.status === 307 && loc === '/login' ? 'PASS' : 'FAIL'; }
    else if (identity === 'admin_aal1') { expected = 'redirect /login/mfa'; verdict = r.status === 307 && loc === '/login/mfa' ? 'PASS' : 'FAIL'; }
    else if (identity === 'user') { if (USER_BLOCKED(p)) { expected = 'redirect /'; verdict = r.status === 307 && loc === '/' ? 'PASS' : 'FAIL'; } else { expected = '200'; verdict = r.status === 200 ? 'PASS' : 'FAIL'; } }
    else { expected = '200'; verdict = r.status === 200 ? 'PASS' : 'INCONCLUSIVE'; }
    rec({ identity, object: `page ${p}`, op: 'GET', variant: '', req: `GET ${APP}${p} (session cookie of ${identity})`, actual: `${r.status}${loc ? ' -> ' + loc : ''}`, expected, verdict, spec: 'frontend-architecture: proxy sends counter staff away from settings/staff/cash-bank; admins below aal2 to /login/mfa', size: body.length });
  }
}
// pages a counter may open that must not SHOW owner-only figures (P&L, balance sheet, trial balance, GST): compare with what the owner sees
{
  const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
  const money = (t) => new Set((t.match(/\d{1,3}(?:,\d{2,3})*(?:,\d{3})(?:\.\d{2})?|\d+\.\d{2}/g) || []));
  for (const p of ['/reports/pnl', '/reports/balance-sheet', '/reports/trial-balance', '/reports/gst', '/reports/cash-bank', '/settings/audit-trail', '/staff', '/reports']) {
    const r = await get('user', p);
    const b = r.status === 200 ? await r.text() : '';
    const ownerMoney = money(strip(ownerBody[p] || ''));
    const userMoney = money(strip(b));
    const shared = [...userMoney].filter((x) => ownerMoney.has(x) && Number(x.replace(/,/g, '')) >= 1000);
    rec({ identity: 'user', object: `page ${p} (content)`, op: 'GET', variant: 'owner-only figures visible on the page', req: `GET ${p} as user`, actual: r.status === 200 ? `200; ${userMoney.size} money-like figures, ${shared.length} shared with the owner's page${shared.length ? ': ' + shared.slice(0, 6).join(', ') : ''}` : `${r.status} redirect`, expected: 'redirect or no owner-only figures', verdict: r.status !== 200 || (p !== '/reports' && shared.length === 0) ? 'PASS' : (p === '/reports' ? 'INFO' : 'FAIL'), spec: 'db-architecture: no P&L/Balance Sheet for user' });
  }
}

// ================================================================================================
// 2. Export routes and the signed invoice link
// ================================================================================================
const routes = [['/api/reports/aging/xlsx', 'members'], ['/api/reports/stock/xlsx', 'members'], ['/api/reports/day-book/xlsx?from=2026-09-01&to=2026-09-30', 'members'],
  ['/api/reports/cash-bank/xlsx', 'owner'], ['/api/reports/trial-balance/xlsx', 'owner'], ['/api/reports/pnl/xlsx', 'owner'], ['/api/reports/balance-sheet/xlsx', 'owner'], ['/api/reports/gstr3b/xlsx?month=2026-09', 'owner'],
  ['/api/reports/gstr1?month=2026-09', 'owner'], [`/api/parties/${C.kishore}/statement.pdf`, 'members'], [`/api/parties/${C.kishore}/statement.xlsx`, 'members'], [`/api/invoices/${inv}/pdf`, 'members']];
for (const [path, who] of routes) {
  for (const identity of IDENT) {
    const r = await get(identity, path);
    const ct = r.headers.get('content-type') || '';
    const gotFile = r.status === 200 && /pdf|spreadsheet|octet|json/.test(ct);
    const allowed = identity === 'admin_aal2' || (identity === 'user' && who === 'members');
    const expected = allowed ? 'file' : 'refused (401/403/redirect)';
    const verdict = allowed ? (gotFile ? 'PASS' : 'INCONCLUSIVE') : (gotFile ? 'FAIL' : 'PASS');
    if (identity === 'admin_aal2') { out.push({ identity, object: `route ${path}`, op: 'GET', actual: `${r.status} ${ct}`, verdict: verdict === 'PASS' ? 'CONTROL' : 'INCONCLUSIVE' }); if (verdict !== 'PASS') console.log('owner control failed', path, r.status, ct); continue; }
    rec({ identity, object: `route ${path.split('?')[0]}`, op: 'GET', variant: '', req: `GET ${path} (cookie of ${identity})`, actual: `${r.status} ${ct.split(';')[0]}${r.headers.get('location') ? ' -> ' + r.headers.get('location') : ''}`, expected, verdict, spec: 'api-architecture: exports refuse without a session; owner-only reports 403 to a counter; only the signed link is public' });
  }
}
// signed WhatsApp link: the only public shape
{
  const sign = (id, exp) => crypto.createHmac('sha256', LINK_SECRET).update(`${id}.${exp}`).digest('base64url');
  const now = Math.floor(Date.now() / 1000);
  const other = one(`select id from sales_invoices where status='posted' and id<>'${inv}' order by created_at limit 1`);
  const draft = fx.mkSales();
  const cases = [
    ['valid signed link (public, no cookie)', `/api/invoices/${inv}/pdf?exp=${now + 3600}&sig=${sign(inv, now + 3600)}`, [200], true],
    ['link signed for ANOTHER invoice', `/api/invoices/${inv}/pdf?exp=${now + 3600}&sig=${sign(other, now + 3600)}`, [403]],
    ['exp extended after signing', `/api/invoices/${inv}/pdf?exp=${now + 999999}&sig=${sign(inv, now + 3600)}`, [403]],
    ['expired link with a valid signature', `/api/invoices/${inv}/pdf?exp=${now - 10}&sig=${sign(inv, now - 10)}`, [403]],
    ['signature present but empty', `/api/invoices/${inv}/pdf?exp=${now + 3600}&sig=`, [403]],
    ['sig with no exp', `/api/invoices/${inv}/pdf?sig=${sign(inv, now + 3600)}`, [403]],
    ['no sig, no session', `/api/invoices/${inv}/pdf`, [307, 401]],
    ['valid link, DRAFT invoice (existence oracle)', `/api/invoices/${draft}/pdf?exp=${now + 3600}&sig=${sign(draft, now + 3600)}`, [409, 404, 403], false],
    ['garbage id with sig', `/api/invoices/not-a-uuid/pdf?exp=${now + 3600}&sig=x`, [404, 403, 307]],
    ['signed link used on a different route (statement)', `/api/parties/${C.kishore}/statement.pdf?exp=${now + 3600}&sig=${sign(C.kishore, now + 3600)}`, [307, 401, 403]],
    ['signed link on the report export', `/api/reports/aging/xlsx?exp=${now + 3600}&sig=${sign(inv, now + 3600)}`, [307, 401, 403]],
  ];
  for (const [title, path, okStatuses, publicOk] of cases) {
    const r = await fetch(APP + path, { redirect: 'manual' });
    const pass = okStatuses.includes(r.status);
    rec({ identity: 'anon', object: 'route /api/invoices/[id]/pdf', op: 'GET', variant: title, req: `GET ${path.replace(/sig=[^&]{8,}/, 'sig=<hmac>')} (no cookie)`, actual: `${r.status} ${(r.headers.get('content-type') || '').split(';')[0]}`, expected: okStatuses.join('/'), verdict: pass ? 'PASS' : 'FAIL', spec: 'api-architecture: the signed WhatsApp link is the only public shape' });
  }
}

// ================================================================================================
// 3. Server actions: every action, every identity, gate order
// ================================================================================================
const man = JSON.parse(fs.readFileSync(`${ROOT}/.next/server/server-reference-manifest.json`, 'utf8')).node;
const actions = Object.entries(man).map(([id, v]) => ({ id, file: v.filename, name: v.exportedName, pages: Object.keys(v.workers || {}) }));
const toUrl = (w) => '/' + w.replace(/^app\//, '').replace(/\/(page|route)$/, '').replace(/\([^)]*\)\/?/g, '').replace(/\[[^\]]+\]/g, '00000000-0000-4000-8000-000000000000').replace(/\/$/, '');
async function callAction(identity, action, args, pathOverride) {
  const path = pathOverride ?? toUrl(action.pages[0] ?? 'app/page');
  const r = await fetch(APP + (path === '/' ? '/' : path), { method: 'POST', redirect: 'manual', headers: { cookie: COOKIE[identity], 'Content-Type': 'text/plain;charset=UTF-8', Accept: 'text/x-component', 'Next-Action': action.id, Origin: APP }, body: JSON.stringify(args) });
  const t = await r.text();
  const code = /"code":"([a-z_]+)"/.exec(t)?.[1];
  const okv = /"ok":true/.test(t);
  return { status: r.status, loc: r.headers.get('location'), code, ok: okv, snippet: t.slice(0, 160).replace(/\s+/g, ' ') };
}
const summarize = (o) => (o.status === 307 ? `307 -> ${new URL(o.loc, APP).pathname}` : o.ok ? 'ok:true' : o.code ? `code:${o.code}` : `${o.status} ${o.snippet.slice(0, 60)}`);
// which actions must be refused to a counter user (owner-only in the api spec), by exported name
const OWNER_ONLY = new Set(['inviteUser', 'disableUser', 'enableUser', 'resetUserPassword', 'addOpeningPartyLine', 'addOpeningMoneyLine', 'addOpeningStockLine', 'removeOpeningLine', 'importOpeningStock', 'postOpening', 'cancelOpening',
  'reopenDay', 'createItem', 'updateItem', 'deactivateItem', 'reactivateItem', 'updateOrganization', 'bounceCheque', 'cancelPayment', 'cancelInvoice', 'setPeriodLock', 'createFiscalYear',
  'recordAdvance', 'recordSalary', 'recordWages', 'createEmployee', 'updateEmployee', 'recordAdjustment', 'recordTransfer', 'receiveTransfer', 'startTotpEnrollment', 'verifyTotp', 'deactivateParty', 'reactivateParty']);
const summary = [];
const SKIP = new Set(['signOut']); // revokes the session server-side: would kill the identities under test
const refusedRes = (r) => r.status === 307 || r.code === 'forbidden' || [400, 401, 403, 404, 405].includes(r.status);
for (const a of actions.sort((x, y) => (x.file + x.name).localeCompare(y.file + y.name))) {
  if (SKIP.has(a.name)) continue;
  const row = { action: `${a.file?.split('/').pop()}:${a.name}`, pages: a.pages.length };
  const cand = a.pages.map(toUrl);
  for (const identity of ['admin_aal2', 'user', 'admin_aal1', 'user_off', 'anon']) {
    const reachable = cand.find((p) => identity === 'user' ? !USER_BLOCKED(p) : true) ?? cand[0] ?? '/';
    const res = await callAction(identity, a, [{}], reachable);
    row[identity] = summarize(res); row.reachedVia = row.reachedVia ?? reachable;
    let expected, verdict;
    const ownerOnly = OWNER_ONLY.has(a.name);
    if (identity === 'admin_aal2') { row[identity + '_res'] = res; continue; }
    if (identity === 'user' && !ownerOnly) { expected = 'gate open (not forbidden)'; verdict = res.code === 'forbidden' ? 'FAIL' : 'PASS'; }
    else {
      expected = 'refused';
      if (a.name === 'signIn') { expected = 'n/a (sign-in form)'; verdict = 'PASS'; }
      else verdict = res.ok ? 'FAIL' : refusedRes(res) ? 'PASS' : 'INCONCLUSIVE';
    }
    rec({ identity, object: `action ${row.action}`, op: 'POST', variant: `via ${reachable}`, req: `POST ${reachable} Next-Action:${a.id.slice(0, 8)}… body [{}]`, actual: row[identity], expected, verdict, spec: 'api-architecture: role gates mirror the database; actions never trust the UI' });
  }
  summary.push(row);
}
// cross-page: an owner-only action id posted to a page the counter CAN reach (the proxy blocks /settings, /staff, cash-bank by URL only)
for (const a of actions.filter((x) => OWNER_ONLY.has(x.name) && !SKIP.has(x.name))) {
  for (const target of ['/', '/parties']) {
    const res = await callAction('user', a, [{}], target);
    const verdict = res.ok ? 'FAIL' : refusedRes(res) ? 'PASS' : 'INCONCLUSIVE';
    rec({ identity: 'user', object: `action ${a.file?.split('/').pop()}:${a.name}`, op: 'POST', variant: `cross-page via ${target}`, req: `POST ${target} Next-Action:${a.id.slice(0, 8)}… body [{}]`, actual: summarize(res), expected: 'refused', verdict, spec: 'defence in depth: the action id must not be usable from another URL' });
  }
}
fs.writeFileSync(OUT + '/actions-summary.json', JSON.stringify(summary, null, 1));
for (const r of summary) console.log(`${r.action.padEnd(38)} owner=${r.admin_aal2.padEnd(20)} user=${r.user.padEnd(22)} aal1=${r.admin_aal1.padEnd(20)} off=${r.user_off.padEnd(16)} anon=${r.anon}`);

fs.writeFileSync(OUT + '/findings-5.json', JSON.stringify(out, null, 1));
saveResults('results-5');
console.log(JSON.stringify({ ran, passed, nonpass: out.filter((o) => o.verdict && o.verdict !== 'PASS' && o.verdict !== 'CONTROL').length }));
