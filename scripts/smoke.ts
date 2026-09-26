// HTTP smoke against a running app + local Supabase (CI, after `next start`). Exit 1 lists what failed.
//   node scripts/smoke.ts --app http://localhost:3000 --supabase http://127.0.0.1:54321 --key <publishable key>
import {
  checkFreshNonce, checkLoginPage, checkManifest, checkRedirectsToLogin, checkRefused, checkServiceWorker, checkSignupDisabled, type Res,
} from './lib/smoke-checks.ts';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const app = (arg('app', process.env.APP_URL ?? 'http://localhost:3000') as string).replace(/\/$/, '');
const supabase = (arg('supabase', process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321') as string).replace(/\/$/, '');
const key = arg('key', process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '') as string;

async function get(url: string, init: RequestInit = {}): Promise<Res> {
  const res = await fetch(url, { redirect: 'manual', ...init });
  return { status: res.status, headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])), body: await res.text() };
}

const failures: string[] = [];
const run = (name: string, bad: string[]) => {
  console.log(`${bad.length ? 'FAIL' : 'ok  '}  ${name}`);
  for (const b of bad) {
    console.log(`        - ${b}`);
    failures.push(`${name}: ${b}`);
  }
};

const UUID = '11111111-1111-4111-8111-111111111111';
const login1 = await get(`${app}/login`);
const login2 = await get(`${app}/login`);
run('sign-in page and security headers', checkLoginPage(login1));
run('CSP nonce is fresh per request', checkFreshNonce(login1, login2));
for (const p of ['/', '/sales', '/reports', '/reports/day-close', '/settings', '/stock']) {
  run(`signed-out ${p} goes to /login`, checkRedirectsToLogin(p, await get(`${app}${p}`)));
}
run('signed-out report Excel is refused', checkRefused('/api/reports/aging/xlsx', await get(`${app}/api/reports/aging/xlsx`)));
run('signed-out cash book Excel is refused', checkRefused('/api/reports/cash-bank/xlsx', await get(`${app}/api/reports/cash-bank/xlsx`)));
run('invoice PDF without a signature is refused', checkRefused('/api/invoices/…/pdf', await get(`${app}/api/invoices/${UUID}/pdf`)));
run('web app manifest', checkManifest(await get(`${app}/api/manifest.webmanifest`)));
run('service worker', checkServiceWorker(await get(`${app}/sw.js`)));

if (key) {
  const post = (path: string, body: object) =>
    get(`${supabase}${path}`, { method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  run('Supabase signup is a dead end', checkSignupDisabled('signup', await post('/auth/v1/signup', { email: 'smoke-nobody@example.test', password: 'Sm0ke!Sm0ke!Sm0ke' })));
  run('a code for an unknown email creates no account', checkSignupDisabled('otp', await post('/auth/v1/otp', { email: 'smoke-nobody2@example.test', create_user: true })));
} else {
  console.log('skip  Supabase signup checks (no --key / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)');
}

if (failures.length) {
  console.error(`\nsmoke: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nsmoke: all checks passed');
