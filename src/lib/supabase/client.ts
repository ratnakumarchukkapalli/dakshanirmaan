import { createBrowserClient } from '@supabase/ssr';
import { sessionCookieOptions } from './cookie-options';

/** Browser client. Publishable key only — the secret key never reaches client code. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookieOptions: sessionCookieOptions() },
  );
}
