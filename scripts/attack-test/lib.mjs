// Shared helpers for the attack test. LOCAL Supabase only (asserted below).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../..');
export const OUT = path.join(HERE, 'out'); // results and identities land here (git-ignored)
export const SP = OUT;
fs.mkdirSync(OUT, { recursive: true });
const ROOT = REPO;

// --- env: read .env.local without printing it -------------------------------------------------
const env = {};
for (const line of fs.readFileSync(`${ROOT}/.env.local`, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
export const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(URL_)) throw new Error('REFUSING: not the local Supabase: ' + URL_);
export const PUB = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
export const SECRET = env.SUPABASE_SECRET_KEY;
// Legacy anon JWT of the local stack (public demo value, printed by `supabase status`).
export const LEGACY_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
export const APP_ORIGIN = 'http://127.0.0.1:3100';

// --- http --------------------------------------------------------------------------------------
export async function http(method, path, { token, apikey = PUB, body, headers = {}, raw = false } = {}) {
  const h = { apikey, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const res = await fetch(URL_ + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

// --- TOTP (RFC 6238) ---------------------------------------------------------------------------
function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export function totp(secret, offset = 0) {
  const counter = Math.floor(Date.now() / 30000) + offset;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- auth flows --------------------------------------------------------------------------------
export const adminApi = (method, path, body) => http(method, path, { token: SECRET, apikey: SECRET, body });
export async function signIn(email, password) {
  const r = await http('POST', '/auth/v1/token?grant_type=password', { body: { email, password } });
  if (r.status !== 200) throw new Error(`sign-in failed ${email}: ${r.status} ${r.text}`);
  return r.json; // access_token, refresh_token, user
}
export async function enrollAndVerify(accessToken) {
  const en = await http('POST', '/auth/v1/factors', { token: accessToken, body: { factor_type: 'totp', friendly_name: 'attack-' + Date.now() } });
  if (en.status !== 200) throw new Error('enroll failed ' + en.status + ' ' + en.text);
  const secret = en.json.totp.secret;
  const factorId = en.json.id;
  const session = await verifyFactor(accessToken, factorId, secret);
  return { secret, factorId, session };
}
export async function verifyFactor(accessToken, factorId, secret) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ch = await http('POST', `/auth/v1/factors/${factorId}/challenge`, { token: accessToken, body: {} });
    if (ch.status !== 200) throw new Error('challenge failed ' + ch.status + ' ' + ch.text);
    const v = await http('POST', `/auth/v1/factors/${factorId}/verify`, { token: accessToken, body: { challenge_id: ch.json.id, code: totp(secret) } });
    if (v.status === 200) return v.json;
    await sleep(31000); // same code twice in a window is refused; wait for the next step
  }
  throw new Error('verify failed');
}

export function jwtClaims(t) {
  return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
}

// --- identities --------------------------------------------------------------------------------
export const ID_FILE = `${SP}/identities.json`;
export const loadIdentities = () => JSON.parse(fs.readFileSync(ID_FILE, 'utf8'));

// Build the token header set for an identity. anon has no bearer at all (only the apikey header).
export function idOpts(identity) {
  return identity.token ? { token: identity.token } : {};
}

// --- result logging ----------------------------------------------------------------------------
export const results = [];
export function record(r) { results.push(r); }
export function saveResults(name) { fs.writeFileSync(`${SP}/${name}.json`, JSON.stringify(results, null, 1)); }

// PostgREST error code of a response ('' if success)
export function errCode(r) {
  if (r.status < 400) return '';
  const j = r.json;
  return (j && (j.code || j.error_code || j.error)) ? String(j.code || j.error_code || j.error) : 'HTTP' + r.status;
}
export function errMsg(r) {
  const j = r.json;
  return j ? [j.message, j.details, j.hint].filter(Boolean).join(' | ') : r.text.slice(0, 200);
}
