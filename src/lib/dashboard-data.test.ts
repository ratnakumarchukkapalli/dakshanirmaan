import { describe, expect, it, vi } from 'vitest';
import { loadAttention, loadBalances, loadBooksDifference, loadCashBank, loadDayClose, loadSalesWeek, loadStockValue, settle } from './dashboard-data';

vi.mock('server-only', () => ({}));

type Reply = { data?: unknown; error?: { message: string } | null; count?: number | null };

/** A stand-in for the Supabase client: records what was read, answers per table/view name. */
function fake(replies: Record<string, Reply>) {
  const reads: { name: string; columns: string }[] = [];
  const client = {
    from(name: string) {
      const reply = replies[name] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {
        select(columns: string) { reads.push({ name, columns }); return chain; },
        eq: () => chain, gte: () => chain, lte: () => chain, in: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null, ...reply }),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null, ...reply }).then(ok, bad),
      };
      return chain;
    },
  };
  return { client: client as never, reads };
}

describe('loaders', () => {
  it('a counter session never reads an owner-only view or column', async () => {
    const { client, reads } = fake({
      v_party_balances: { data: [{ ar_balance: 100.5 }, { ar_balance: 20 }] },
      v_attention: { data: [] },
      v_sales_daily: { data: [] }, v_sales_daily_category: { data: [] },
    });
    await loadBalances(client, false);
    await loadAttention(client);
    await loadSalesWeek(client, '2026-09-25');
    const names = reads.map((r) => r.name);
    for (const admin of ['v_money_balances', 'v_stock_summary', 'v_stock_summary_all', 'v_trial_balance']) expect(names).not.toContain(admin);
    expect(reads.find((r) => r.name === 'v_party_balances')!.columns).toBe('ar_balance');
    expect(reads.map((r) => r.columns).join(' ')).not.toMatch(/ap_balance|avg_rate|value|closing/);
  });

  it('balances: exact sums, payables only for the owner', async () => {
    const { client } = fake({ v_party_balances: { data: [{ ar_balance: 0.1, ap_balance: 500 }, { ar_balance: 0.2, ap_balance: 0 }, { ar_balance: -5, ap_balance: 250.25 }] } });
    expect(await loadBalances(client, true)).toEqual({ toCollect: '-4.70', toPay: '750.25', suppliersOwed: 2 });
    expect(await loadBalances(client, false)).toMatchObject({ toPay: null, suppliersOwed: null });
  });

  it('a failed query fails loudly instead of returning an empty section', async () => {
    const { client } = fake({ v_attention: { data: null, error: { message: 'column v_attention.nope does not exist' } } });
    await expect(loadAttention(client)).rejects.toThrow(/attention: column/);
    const { client: c2 } = fake({ v_money_balances: { data: null, error: { message: 'permission denied' } } });
    await expect(loadCashBank(c2)).rejects.toThrow(/cash and bank balances: permission denied/);
  });

  it('a list cut short by the server row cap throws (a truncated total would be silently wrong)', async () => {
    const { client } = fake({ v_party_balances: { data: [{ ar_balance: 1 }], count: 1500 } });
    await expect(loadBalances(client, false)).rejects.toThrow(/1500 rows exist/);
  });

  it('settle turns a failure into a visible error state and logs it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await settle('x', async () => { throw new Error('boom'); })).toEqual({ ok: false });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(await settle('y', async () => 5)).toEqual({ ok: true, data: 5 });
  });

  it('cash and bank, stock value and books difference are exact', async () => {
    const { client } = fake({
      v_money_balances: { data: [{ system_key: 'cash', balance: 41300.1 }, { system_key: 'bank', balance: 300880.2 }] },
      v_stock_summary: { data: [{ value: 100.1 }, { value: 200.2 }] },
      v_stock_summary_all: { data: [{ value: 71523 }] },
      v_trial_balance: { data: [{ total_debit: 10.1, total_credit: 0 }, { total_debit: 0, total_credit: 10.1 }] },
    });
    expect(await loadCashBank(client)).toEqual({ total: '342180.30', cash: '41300.10' });
    expect(await loadStockValue(client)).toEqual({ onHand: '300.30', inTransit: '71523.00' });
    expect(await loadBooksDifference(client)).toBe('0.00');
  });

  it('attention: overdue total, low-stock names, most urgent first', async () => {
    const { client } = fake({
      v_attention: { data: [
        { kind: 'low_stock', severity: 'warning', subject_type: 'item', subject_id: 'i1', title: 'Low stock: A', detail: '', due_date: null, amount: null, interest: null },
        { kind: 'overdue_party', severity: 'critical', subject_type: 'party', subject_id: 'p1', title: 'Overdue: P', detail: '', due_date: '2026-08-01', amount: 100.1, interest: 5 },
        { kind: 'overdue_party', severity: 'warning', subject_type: 'party', subject_id: 'p2', title: 'Overdue: Q', detail: '', due_date: '2026-09-01', amount: 0.2, interest: 0 },
      ] },
      items: { data: [{ id: 'i1', name: 'ACC Gold 50kg' }] },
    });
    const a = await loadAttention(client);
    expect(a.rows[0]!.kind).toBe('overdue_party');
    expect(a.overdue).toEqual({ parties: 2, amount: '100.30' });
    expect(a.lowStock).toEqual({ count: 1, names: ['ACC Gold 50kg'] });
  });

  it('day close: the latest posted close, or none', async () => {
    const { client } = fake({ day_closes: { data: { close_date: '2026-09-24', difference: 0 } } });
    expect(await loadDayClose(client)).toEqual({ last: { date: '2026-09-24', difference: '0.00' } });
    const { client: none } = fake({ day_closes: { data: null } });
    expect(await loadDayClose(none)).toEqual({ last: null });
  });

  it('sales week: seven zero-filled days plus the draft count', async () => {
    const { client } = fake({
      v_sales_daily: { data: [{ sale_date: '2026-09-25', invoice_count: 1, billed_total: 500, round_off: 0 }] },
      v_sales_daily_category: { data: [{ sale_date: '2026-09-25', category: 'cement', amount: 500 }] },
      sales_invoices: { data: null, count: 3 },
    });
    const w = await loadSalesWeek(client, '2026-09-25');
    expect(w.days).toHaveLength(7);
    expect(w.days[6]).toMatchObject({ date: '2026-09-25', total: '500.00', cement: '500.00' });
    expect(w.drafts).toBe(3);
  });
});
