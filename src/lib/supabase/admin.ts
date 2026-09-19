import 'server-only';
import { createClient } from '@supabase/supabase-js';

/**
 * Service client: bypasses RLS. Server-only, and only inside actions that re-check the caller's
 * role first (user invites, change 08). Never import this from a component or a route that
 * serves data directly.
 */
export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
