import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({
  claims: null as Record<string, unknown> | null,
  row: null as Record<string, unknown> | null,
  lookedUp: false,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: h.claims ? { claims: h.claims } : null }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            h.lookedUp = true;
            return { data: h.row };
          },
        }),
      }),
    }),
  }),
}));

import { getCurrentMember } from './current';

const nowSec = () => Math.floor(Date.now() / 1000);
const claimsSignedInAgo = (hours: number, extra: Record<string, unknown> = {}) => ({
  sub: 'u-1',
  aal: 'aal1',
  amr: [{ method: 'otp', timestamp: nowSec() - hours * 3600 }],
  ...extra,
});

beforeEach(() => {
  h.claims = null;
  h.row = { role: 'user', name: 'Suresh', is_active: true };
  h.lookedUp = false;
});

describe('getCurrentMember', () => {
  it('returns the member for a fresh session', async () => {
    h.claims = claimsSignedInAgo(1);
    expect(await getCurrentMember()).toEqual({ userId: 'u-1', role: 'user', name: 'Suresh', aal: 'aal1' });
  });
  it('a session older than the limit is no member, and the database is not even asked', async () => {
    h.claims = claimsSignedInAgo(9);
    expect(await getCurrentMember()).toBeNull();
    expect(h.lookedUp).toBe(false);
  });
  it('a token whose sign-in time cannot be established fails closed', async () => {
    h.claims = { sub: 'u-1', aal: 'aal1', amr: [] };
    expect(await getCurrentMember()).toBeNull();
  });
  it('a disabled member is no member', async () => {
    h.claims = claimsSignedInAgo(1);
    h.row = { role: 'user', name: 'Suresh', is_active: false };
    expect(await getCurrentMember()).toBeNull();
  });
  it('no claims is no member', async () => {
    expect(await getCurrentMember()).toBeNull();
  });
});
