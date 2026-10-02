import { createClient } from '@supabase/supabase-js';

/**
 * A publishable-key client that keeps no session anywhere: nothing is written to cookies or storage and
 * nothing is refreshed. Used to check a password ("is this really you?") without touching the caller's
 * own sign-in. The session the service creates for the check is ended by the caller.
 */
export function createStatelessClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
