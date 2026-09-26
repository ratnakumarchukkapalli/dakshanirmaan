import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartyLedger } from '@/lib/party-ledger';
import en from '@/messages/en.json';
import te from '@/messages/te.json';

vi.mock('server-only', () => ({}));
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: vi.fn(async () => Buffer.from('%PDF')) }));
vi.mock('./StatementDocument', () => ({ statementDocument: () => null }));
vi.mock('@/lib/invoice-pdf/fonts', () => ({ registerFonts: () => undefined }));
vi.mock('@/lib/auth/current', () => ({ getCurrentMember: async () => ({ userId: 'u', role: 'user', name: 'C', aal: 'aal1' }) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: { legal_name: 'DNT', gstin: null, timezone: 'Asia/Kolkata' }, error: null }) }) }),
  }),
}));
const loadPartyLedger = vi.fn();
vi.mock('@/lib/party-ledger', () => ({ loadPartyLedger: (...a: unknown[]) => loadPartyLedger(...a) }));

const ID = '11111111-1111-4111-8111-111111111111';
const ledger: PartyLedger = {
  party: { id: ID, name: 'A', type: 'customer', gstin: null, phone: null, whatsappPhone: null, isActive: true, stateCode: '37' },
  period: null, broughtForward: {}, rows: [], closing: { ar: '10.00' }, truncated: false,
};

beforeEach(() => loadPartyLedger.mockReset());

describe('statement export of a truncated ledger', () => {
  it('is refused with a clear message, as Excel and as PDF', async () => {
    const { statementResponse } = await import('./handler');
    loadPartyLedger.mockResolvedValue({ ...ledger, truncated: true });
    for (const kind of ['xlsx', 'pdf'] as const) {
      const res = await statementResponse(ID, 'all', kind);
      expect(res.status).toBe(422);
      expect(await res.text()).toBe(en.statement.truncated);
    }
  });

  it('a complete ledger still exports', async () => {
    const { statementResponse } = await import('./handler');
    loadPartyLedger.mockResolvedValue(ledger);
    const res = await statementResponse(ID, 'all', 'pdf');
    expect(res.status).toBe(200);
  });

  it('has the message in both languages', () => {
    expect(en.statement.truncated.length).toBeGreaterThan(20);
    expect(te.statement.truncated.length).toBeGreaterThan(20);
  });
});
