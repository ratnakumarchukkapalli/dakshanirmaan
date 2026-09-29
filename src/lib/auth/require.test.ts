import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, reset } from '@/test/harness';
import { requireOwnerPage } from './require';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
// Next's redirect() throws to stop rendering; the stub does the same so a test can see where it went.
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));

describe('requireOwnerPage (the second lock on an owner-only screen)', () => {
  it('lets a verified owner through and returns them', async () => {
    reset(asAdmin('aal2'));
    expect(await requireOwnerPage()).toMatchObject({ role: 'admin', aal: 'aal2' });
  });
  it('sends a counter user to the dashboard', async () => {
    reset(asCounter());
    await expect(requireOwnerPage()).rejects.toThrow('REDIRECT:/');
  });
  it('sends an owner who has not passed the authenticator step to the dashboard', async () => {
    reset(asAdmin('aal1'));
    await expect(requireOwnerPage()).rejects.toThrow('REDIRECT:/');
  });
  it('sends nobody-signed-in to the dashboard (the proxy sends them to /login first)', async () => {
    reset(null);
    await expect(requireOwnerPage()).rejects.toThrow('REDIRECT:/');
  });
});
