// CI gate: run after `next build`. Exits 1 (and says why) when the browser bundle could leak a secret.
//   node scripts/check-bundle.ts [dir=.next/static]
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

const root = process.argv[2] ?? '.next/static';
if (!existsSync(root)) {
  console.error(`check-bundle: ${root} does not exist — run \`npm run build\` first.`);
  process.exit(2);
}

// Values of the server-only variables, if this environment has them (CI sets throwaway ones).
const secretValues = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'INVOICE_LINK_SECRET']
  .map((k) => process.env[k])
  .filter((v): v is string => !!v);

const findings: Finding[] = [];
let files = 0;
for (const file of walk(root)) {
  if (!/\.(js|mjs|css|html|json|map|txt)$/.test(file)) continue;
  files++;
  findings.push(...scanContent(file, readFileSync(file, 'utf8'), secretValues));
}

const exampleNames = existsSync('.env.example') ? envNames(readFileSync('.env.example', 'utf8')) : [];
const strayVars = disallowedPublicVars([...Object.keys(process.env), ...exampleNames]);

if (files === 0) {
  console.error(`check-bundle: no scannable files found in ${root} — a scan of nothing proves nothing.`);
  process.exit(2);
}
for (const f of findings) console.error(`LEAK  ${f.kind}  ${f.file}  (${f.detail})`);
for (const v of strayVars) console.error(`STRAY ${v} — only NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY may reach the browser`);

if (findings.length || strayVars.length) process.exit(1);
console.log(`check-bundle: ${files} files scanned in ${root}, no secret found, no stray NEXT_PUBLIC_ variable.`);
