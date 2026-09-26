// Creates the FIRST owner account. Nobody can sign up, so this is how the business gets its
// first admin (local or hosted). Run by a person, with the service key in the environment:
//
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//     npm run create-admin -- owner@example.com "Owner Name"
//
// The password comes from the ADMIN_PASSWORD environment variable (at least 8 characters); at a terminal
// without it you are asked for one (hidden, twice); otherwise a random one is made and printed once. Never pass it on the command line (it would sit in shell history).
// Refuses to run when an active admin already exists, unless --force. No email is sent: the person signs in
// with the email and password, then sets up their authenticator app.
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import { createClient } from '@supabase/supabase-js';

/** Reads a line from the terminal without echoing it (stars instead). */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    rl.stdoutMuted = true;
    rl._writeToOutput = (text) => rl.output.write(rl.stdoutMuted ? '*'.repeat(text.replace(/[\r\n]/g, '').length) : text);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const args = process.argv.slice(2).filter((a) => a !== '--force');
const force = process.argv.includes('--force');
const [emailArg, nameArg] = args;
const email = emailArg?.trim().toLowerCase();
const name = nameArg?.trim();

if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
  console.error('Usage: npm run create-admin -- <email> "<name>" [--force]');
  process.exit(2);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
let key = process.env.SUPABASE_SECRET_KEY;
// The Supabase CLI only shows a masked secret key, so on a terminal the real one is asked for (hidden).
if (!key && process.stdin.isTTY) key = (await askHidden('1/3  Supabase SECRET key (starts with sb_secret_; from the dashboard): ')).trim();
if (key && !/^sb_secret_[A-Za-z0-9_-]{20,}$/.test(key) && !/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
  console.error('That does not look like a Supabase SECRET key (it starts with sb_secret_). The first prompt asks for the key, the next two for the password. Nothing was created.');
  process.exit(2);
}
if (!url || !key) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY first.');
  process.exit(2);
}

let password = process.env.ADMIN_PASSWORD;
if (!password && process.stdin.isTTY) {
  // At a terminal with no ADMIN_PASSWORD: ask for it, twice, without showing it.
  password = await askHidden('2/3  Choose the owner password (8-72 characters): ');
  const again = await askHidden('3/3  Type the password again: ');
  if (password !== again) {
    console.error('The two passwords are different. Nothing was created.');
    process.exit(2);
  }
}
const generated = !password;
if (generated) password = randomBytes(15).toString('base64url');
if (password.length < 8 || password.length > 72) {
  console.error('ADMIN_PASSWORD must be 8 to 72 characters.');
  process.exit(2);
}

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: existing, error: listError } = await admin.from('app_users').select('email').eq('role', 'admin').eq('is_active', true);
if (listError) {
  console.error('Could not read app_users:', listError.message);
  process.exit(1);
}
if (existing.length && !force) {
  console.error(`An active admin already exists (${existing.map((r) => r.email ?? 'no email').join(', ')}). Use the Users screen, or pass --force.`);
  process.exit(1);
}

let userId;
const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (created.data.user) {
  userId = created.data.user.id;
} else if (created.error?.code === 'email_exists') {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  userId = data.users.find((u) => u.email?.toLowerCase() === email)?.id;
  if (userId) await admin.auth.admin.updateUserById(userId, { password });
}
if (!userId) {
  console.error('Could not create the sign-in account:', created.error?.message);
  process.exit(1);
}

const { error } = await admin
  .from('app_users')
  .upsert({ user_id: userId, email, name, role: 'admin', is_active: true, invited_at: new Date().toISOString() }, { onConflict: 'user_id' });
if (error) {
  console.error('Could not record the admin:', error.message);
  process.exit(1);
}
console.log(`Admin ready: ${name} <${email}>. Open the app, sign in with this email and password, then set up the authenticator app.`);
if (generated) console.log(`Password (shown once, write it down): ${password}`);
