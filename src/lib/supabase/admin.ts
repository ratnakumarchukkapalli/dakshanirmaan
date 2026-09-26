import 'server-only';
import { createClient } from '@supabase/supabase-js';

/**
 * Service client: bypasses RLS. Server-only, and only inside actions that re-check the caller's
 * role first (user invites, change 08). Never import this from a component or a route that
 * serves data directly.
 *
 * The one exception is the public signed-link invoice PDF route (`/api/invoices/[id]/pdf` with
 * `?exp=&sig=`, change 10b): it serves data with no session, and only after the HMAC signature
 * over the invoice id and expiry has been verified (`src/lib/share-link.ts`). It reads that one
 * invoice and nothing else. Do not copy this pattern: any other route must use the user-scoped
 * client, and a new signed-link surface needs the same review.
 */
export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
