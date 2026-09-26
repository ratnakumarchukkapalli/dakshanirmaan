// Creates the FIRST owner account. Nobody can sign up, so this is how the business gets its
// first admin (local or hosted). Run by a person, with the service key in the environment:
//
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//     npm run create-admin -- owner@example.com "Owner Name"
//
// The password comes from the ADMIN_PASSWORD environment variable (at least 12 characters); without it a
// random one is made and printed once. Never pass it on the command line (it would sit in shell history).
// Refuses to run when an active admin already exists, unless --force. No email is sent: the person signs in
// with the email and password, then sets up their authenticator app.
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

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
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY first.');
  process.exit(2);
}

let password = process.env.ADMIN_PASSWORD;
const generated = !password;
if (generated) password = randomBytes(15).toString('base64url');
if (password.length < 12 || password.length > 72) {
  console.error('ADMIN_PASSWORD must be 12 to 72 characters.');
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
