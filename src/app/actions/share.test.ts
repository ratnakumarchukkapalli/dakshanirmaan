import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyInvoiceLink } from '@/lib/share-link';
import { asAdmin, asCounter, dbError, reset, state, type Call } from '@/test/harness';
import { whatsappInvoiceLink } from './share';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'localhost:3000' }) }));
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const INV = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';

function healthy(over: Partial<{ status: string; whatsapp: string | null; phone: string | null; found: boolean }> = {}) {
  const { status = 'posted', whatsapp = '98765 43210', phone = null, found = true } = over;
  state.respond = (c: Call) => {
    if (c.table === 'sales_invoices') {
      return { data: found ? [{ id: INV, status, invoice_no: 'DN/26-27/0001', invoice_date: '2026-07-04', grand_total: 76700, party: { whatsapp_phone: whatsapp, phone } }] : [] };
    }
    if (c.table === 'organization') return { data: [{ legal_name: 'Daksha Nirmaan Traders', trade_name: null }] };
    return { data: null };
  };
}

beforeEach(() => {
  vi.stubEnv('INVOICE_LINK_SECRET', SECRET);
  vi.stubEnv('APP_ORIGIN', 'https://example.test/');
});
afterEach(() => vi.unstubAllEnvs());

describe('whatsappInvoiceLink', () => {
  it('builds a signed 24-hour link and a wa.me message for the customer', async () => {
    reset(asCounter());
    healthy();
    const r = await whatsappInvoiceLink({ id: INV });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const url = new URL(r.data.link);
    expect(url.origin + url.pathname).toBe(`https://example.test/api/invoices/${INV}/pdf`);
    expect(verifyInvoiceLink(INV, url.searchParams.get('exp'), url.searchParams.get('sig'), SECRET)).toBe('ok');
    // The signature is for this invoice only.
    expect(verifyInvoiceLink('22222222-2222-4222-8222-222222222222', url.searchParams.get('exp'), url.searchParams.get('sig'), SECRET)).toBe('invalid');
    const wa = new URL(r.data.whatsappUrl!);
    expect(wa.origin + wa.pathname).toBe('https://wa.me/919876543210');
    const text = wa.searchParams.get('text')!;
    expect(text).toContain('DN/26-27/0001');
    expect(text).toContain('04-07-2026');
    expect(text).toContain('₹76,700.00');
    expect(text).toContain(r.data.link);
    expect(r.data.expires).toBeGreaterThan(Date.now() / 1000 + 23 * 3600);
  });

  it('with no usable mobile number it still gives the link to copy, but no WhatsApp address', async () => {
    reset(asCounter());
    healthy({ whatsapp: null });
    const r = await whatsappInvoiceLink({ id: INV });
    expect(r).toMatchObject({ ok: true, data: { whatsappUrl: null } });
  });

  it('never uses the ordinary phone: it may be a landline stored without its trunk zero', async () => {
    reset(asAdmin());
    healthy({ whatsapp: null, phone: '9876543210' });
    expect(await whatsappInvoiceLink({ id: INV })).toMatchObject({ ok: true, data: { whatsappUrl: null } });
    expect(state.calls.find((c) => c.table === 'sales_invoices')?.op).toBe('select');
  });

  it('refuses a draft, a cancelled invoice and one that is not there', async () => {
    for (const over of [{ status: 'draft' }, { status: 'cancelled' }, { found: false }]) {
      reset(asCounter());
      healthy(over);
      expect(await whatsappInvoiceLink({ id: INV })).toMatchObject({ ok: false, code: 'not_posted' });
    }
  });

  it('never falls back to an unsigned link: a missing or short secret, or no origin in production, is refused', async () => {
    for (const setup of [
      () => vi.stubEnv('INVOICE_LINK_SECRET', ''),
      () => vi.stubEnv('INVOICE_LINK_SECRET', 'too-short'),
      () => { vi.stubEnv('APP_ORIGIN', ''); vi.stubEnv('NODE_ENV', 'production'); },
    ]) {
      vi.unstubAllEnvs();
      vi.stubEnv('INVOICE_LINK_SECRET', SECRET);
      vi.stubEnv('APP_ORIGIN', 'https://example.test');
      setup();
      reset(asCounter());
      healthy();
      const r = await whatsappInvoiceLink({ id: INV });
      expect(r).toEqual({ ok: false, code: 'validation', error: 'validation.share_not_configured' });
      expect(state.calls).toHaveLength(0);
    }
  });

  it('in development the request host stands in for APP_ORIGIN', async () => {
    vi.stubEnv('APP_ORIGIN', '');
    reset(asCounter());
    healthy();
    const r = await whatsappInvoiceLink({ id: INV });
    expect(r.ok && r.data.link.startsWith('http://localhost:3000/api/invoices/')).toBe(true);
  });

  it('refuses a signed-out visitor and an owner at step one, before any read; maps a database error', async () => {
    reset(null);
    healthy();
    expect(await whatsappInvoiceLink({ id: INV })).toMatchObject({ ok: false, code: 'forbidden' });
    reset(asAdmin('aal1'));
    healthy();
    expect(await whatsappInvoiceLink({ id: INV })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
    reset(asCounter());
    state.respond = () => dbError('boom');
    expect(await whatsappInvoiceLink({ id: INV })).toMatchObject({ ok: false, code: 'internal' });
  });

  it('a malformed id is a validation failure and reads nothing', async () => {
    reset(asCounter());
    healthy();
    expect(await whatsappInvoiceLink({ id: 'nope' })).toMatchObject({ ok: false, code: 'validation' });
    expect(state.calls).toHaveLength(0);
  });
});
