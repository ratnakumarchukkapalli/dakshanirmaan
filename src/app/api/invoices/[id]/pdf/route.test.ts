import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signInvoiceLink } from '@/lib/share-link';

vi.mock('server-only', () => ({}));
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: async () => Buffer.from('%PDF-fake') }));
vi.mock('@/lib/invoice-pdf/fonts', () => ({ registerFonts: () => undefined }));
vi.mock('@/lib/invoice-pdf/InvoiceDocument', () => ({ invoiceDocument: () => null }));
vi.mock('@/lib/invoice-pdf/upi', () => ({ qrDataUrl: async () => 'data:', upiUri: () => 'upi://' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
const member = vi.hoisted(() => ({ value: null as { role: string; aal: string } | null }));
vi.mock('@/lib/auth/current', () => ({ getCurrentMember: async () => member.value }));
const pdf = vi.hoisted(() => ({ cancelled: false, loads: 0 }));
vi.mock('@/lib/invoice-pdf/data', () => ({
  loadInvoicePdfData: async () => {
    pdf.loads++;
    return { kind: 'ok', data: { number: 'DN/1', cancelled: pdf.cancelled, open: '0.00', org: { upiVpa: null } } };
  },
}));

import { GET } from './route';

const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';
let n = 0;
const newId = () => `d0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function signedRequest(id: string, ip: string, link = signInvoiceLink(id, SECRET)) {
  const url = `http://localhost/api/invoices/${id}/pdf?exp=${link.exp}&sig=${link.sig}`;
  return GET(new NextRequest(url, { headers: { 'x-real-ip': ip } }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.stubEnv('INVOICE_LINK_SECRET', SECRET);
  member.value = null;
  pdf.cancelled = false;
  pdf.loads = 0;
});

describe('signed invoice link: GET /api/invoices/[id]/pdf (A5)', () => {
  it('serves a valid link', async () => {
    const res = await signedRequest(newId(), '198.51.100.1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
  });
  it('answers 410 for a cancelled invoice on a signed link, but a signed-in member still gets the PDF', async () => {
    pdf.cancelled = true;
    const id = newId();
    expect((await signedRequest(id, '198.51.100.2')).status).toBe(410);
    member.value = { role: 'user', aal: 'aal1' };
    const res = await GET(new NextRequest(`http://localhost/api/invoices/${id}/pdf`), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
  });
  it('limits every signed request per address: the 31st in 10 minutes is a 429 with Retry-After, before any work', async () => {
    const ip = '198.51.100.3';
    for (let i = 0; i < 30; i++) expect((await signedRequest(newId(), ip)).status).toBe(200);
    pdf.loads = 0;
    const res = await signedRequest(newId(), ip);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('600');
    expect(pdf.loads).toBe(0);
    // another address is unaffected
    expect((await signedRequest(newId(), '198.51.100.4')).status).toBe(200);
  });
  it('limits one invoice across addresses: the 31st valid request for it is a 429', async () => {
    const id = newId();
    const link = signInvoiceLink(id, SECRET);
    for (let i = 0; i < 30; i++) expect((await signedRequest(id, `203.0.113.${i + 1}`, link)).status).toBe(200);
    const res = await signedRequest(id, '203.0.113.200', link);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('600');
  });
  it('a stranger sending bad signatures for an invoice cannot use up its budget', async () => {
    const id = newId();
    const link = signInvoiceLink(id, SECRET);
    for (let i = 0; i < 15; i++) expect((await signedRequest(id, `192.0.2.${i + 1}`, { exp: link.exp, sig: 'bad' })).status).toBe(403);
    expect((await signedRequest(id, '192.0.2.200', link)).status).toBe(200);
  });
  it('bad signatures still count against the address (403, then 429 once it is over)', async () => {
    const id = newId();
    const link = signInvoiceLink(id, SECRET);
    const ip = '198.51.100.9';
    for (let i = 0; i < 20; i++) expect((await signedRequest(id, ip, { exp: link.exp, sig: 'bad' })).status).toBe(403);
    expect((await signedRequest(id, ip, link)).status).toBe(429);
  });
  it('a signed-out request without a signature is a 401', async () => {
    const id = newId();
    const res = await GET(new NextRequest(`http://localhost/api/invoices/${id}/pdf`), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(401);
  });
});
