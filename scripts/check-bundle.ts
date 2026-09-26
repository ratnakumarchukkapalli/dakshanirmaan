// CI gate: run after `next build`. Exits 1 (and says why) when the browser bundle could leak a secret.
//   node scripts/check-bundle.ts [dir ...]     (default: .next/static and public — everything the browser can download)
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { disallowedPublicVars, envNames, scanContent, type Finding } from './lib/bundle-scan.ts';

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const explicit = process.argv.slice(2);
const roots = explicit.length ? explicit : ['.next/static', 'public'];
// The build output must exist; public/ is optional (an app may have none), but only when it is the default.
for (const r of roots) {
  if (!existsSync(r) && !(r === 'public' && !explicit.length)) {
    console.error(`check-bundle: ${r} does not exist — run \`npm run build\` first.`);
    process.exit(2);
  }
}

// Values of the server-only variables, if this environment has them (CI sets throwaway ones).
const secretValues = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'INVOICE_LINK_SECRET']
  .map((k) => process.env[k])
  .filter((v): v is string => !!v);

const findings: Finding[] = [];
let files = 0;
// Everything except known binary formats is read as text: a key pasted into public/ may have any extension.
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|icns|woff2?|ttf|otf|eot|pdf|mp[34]|webm|zip|gz|br|wasm)$/i;
for (const root of roots.filter((r) => existsSync(r))) {
  for (const file of walk(root)) {
    if (BINARY.test(file)) continue;
    files++;
    findings.push(...scanContent(file, readFileSync(file, 'utf8'), secretValues));
  }
}

const exampleNames = existsSync('.env.example') ? envNames(readFileSync('.env.example', 'utf8')) : [];
const strayVars = disallowedPublicVars([...Object.keys(process.env), ...exampleNames]);

if (files === 0) {
  console.error(`check-bundle: no scannable files found in ${roots.join(', ')} — a scan of nothing proves nothing.`);
  process.exit(2);
}
for (const f of findings) console.error(`LEAK  ${f.kind}  ${f.file}  (${f.detail})`);
for (const v of strayVars) console.error(`STRAY ${v} — only NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY may reach the browser`);

if (findings.length || strayVars.length) process.exit(1);
console.log(`check-bundle: ${files} files scanned in ${roots.join(', ')}, no secret found, no stray NEXT_PUBLIC_ variable.`);
