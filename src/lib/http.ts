import 'server-only';
import { headers } from 'next/headers';
import { pickClientIp } from '@/lib/auth/client-ip';

/** Best-effort caller address for rate limiting. See `pickClientIp` for which header wins. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return pickClientIp((name) => h.get(name));
}
