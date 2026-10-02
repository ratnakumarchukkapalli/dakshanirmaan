import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const probe = vi.hoisted(() => ({ clients: 0, members: 0, rpcs: [] as string[] }));
vi.mock('@/lib/auth/current', () => ({
  getCurrentMember: async () => {
    probe.members += 1;
    return { userId: 'u-owner', role: 'admin', name: 'Owner', aal: 'aal2' };
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    probe.clients += 1;
    return {
      rpc: async (fn: string) => { probe.rpcs.push(fn); return { data: null, error: null }; },
      // The organisation read fails, so an allowed request ends in a 500 right after the gate: enough to see it got past.
      from: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'stop here' } }) }) }),
    };
  },
}));

import { archiveResponse } from './archive-handler';
import { booksResponse } from './books-handler';
import { crossSiteRefusal } from './guard';
import { tallyResponse } from './tally-handler';

const calls: [string, (site: string | null) => Promise<Response>][] = [
  ['books.xlsx', (site) => booksResponse('2026', site)],
  ['archive.zip', (site) => archiveResponse('2026', site)],
  ['tally.xml', (site) => tallyResponse('2026', 'masters', null, site)],
];

beforeEach(() => {
  probe.clients = 0;
  probe.members = 0;
  probe.rpcs.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('crossSiteRefusal', () => {
  it('allows the app itself, an address-bar visit and a request with no header', () => {
    expect(crossSiteRefusal('same-origin')).toBeNull();
    expect(crossSiteRefusal('none')).toBeNull();
    expect(crossSiteRefusal(null)).toBeNull();
    expect(crossSiteRefusal(undefined)).toBeNull();
  });
  it('refuses cross-site, same-site and anything unrecognised with a 403', () => {
    for (const v of ['cross-site', 'same-site', 'Cross-Site', '', 'whatever']) expect(crossSiteRefusal(v)?.status).toBe(403);
  });
});

describe.each(calls)('%s: Sec-Fetch-Site (A6)', (_name, call) => {
  it.each(['cross-site', 'same-site'])('%s is a 403 before the session, the database or the audit row are touched', async (site) => {
    const res = await call(site);
    expect(res.status).toBe(403);
    expect(probe.members).toBe(0);
    expect(probe.clients).toBe(0);
    expect(probe.rpcs).not.toContain('log_export');
  });
  it.each(['same-origin', 'none', null])('%s gets past the gate', async (site) => {
    const res = await call(site);
    expect(res.status).toBe(500); // reached the organisation read, which the stub fails
    expect(probe.clients).toBe(1);
  });
});
