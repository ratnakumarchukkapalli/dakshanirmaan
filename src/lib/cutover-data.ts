import 'server-only';
import { one, rows } from '@/lib/db';
import { decimalText } from '@/lib/decimal';
import { todayIn } from '@/lib/format';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;
const d2 = (v: unknown) => decimalText(v as number | string | null, 2);

export interface OpeningLineView {
  id: string;
  kind: 'party' | 'money' | 'stock';
  /** Party name, account name or item name. */
  name: string;
  side: 'receivable' | 'payable' | null;
  qty: string | null;
  rate: string | null;
  uom: string | null;
  godown: string | null;
  /** Party/money amount; for stock the database computes qty × rate in the preview, so it is not repeated here. */
  amount: string | null;
}

export interface OpeningPreview { lineCount: number; receivable: string; payable: string; money: string; stock: string; equity: string }

export interface CutoverData {
  batch: { id: string; status: 'draft' | 'posted'; asOf: string | null } | null;
  lines: OpeningLineView[];
  preview: OpeningPreview;
  readiness: { key: string; ok: boolean }[];
  parties: { id: string; name: string; type: string; phone: string | null }[];
  accounts: { id: string; name: string }[];
  items: { id: string; name: string; brand: string | null; baseUom: string }[];
  godowns: { id: string; name: string }[];
  /** The day before today in the organisation's time zone: the usual opening date. */
  defaultDate: string;
}

/** Everything the cutover screen shows, read as the signed-in owner (RLS: nobody else sees a row). */
export async function loadCutover(supabase: Supabase, timeZone: string): Promise<CutoverData> {
  const [batchRes, previewRes, readyRes, partiesRes, accountsRes, itemsRes, godownsRes] = await Promise.all([
    supabase.from('opening_batches').select('id, status, as_of').neq('status', 'cancelled').maybeSingle(),
    supabase.rpc('opening_preview'),
    supabase.rpc('go_live_readiness'),
    supabase.from('parties').select('id, name, type, phone').in('type', ['customer', 'supplier', 'both']).eq('is_active', true).order('name'),
    supabase.from('accounts').select('id, name').eq('is_money', true).eq('is_group', false).order('code'),
    supabase.from('items').select('id, name, brand, base_uom').eq('is_stock', true).eq('is_active', true).order('name'),
    supabase.from('warehouses').select('id, name, is_default').eq('is_transit', false).order('is_default', { ascending: false }).order('name'),
  ]);

  const batchRow = one<{ id: string; status: string; as_of: string | null }>(batchRes, 'opening batch');
  const batch = batchRow ? { id: batchRow.id, status: batchRow.status === 'posted' ? ('posted' as const) : ('draft' as const), asOf: batchRow.as_of } : null;

  let lines: OpeningLineView[] = [];
  if (batch) {
    const res = await supabase
      .from('opening_lines')
      .select('id, kind, side, qty, rate, amount, created_at, parties(name), accounts(name), items(name, base_uom), warehouses(name)')
      .eq('batch_id', batch.id)
      .order('kind')
      .order('created_at');
    lines = rows<Record<string, any>>(res, 'opening lines').map((r) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      id: r.id,
      kind: r.kind,
      name: r.parties?.name ?? r.accounts?.name ?? r.items?.name ?? '',
      side: r.side ?? null,
      qty: r.qty == null ? null : decimalText(r.qty, 3),
      rate: r.rate == null ? null : decimalText(r.rate, 4),
      uom: r.items?.base_uom ?? null,
      godown: r.warehouses?.name ?? null,
      amount: r.amount == null ? null : d2(r.amount),
    }));
  }

  const p = rows<Record<string, unknown>>(previewRes, 'opening preview')[0] ?? {};
  const preview: OpeningPreview = {
    lineCount: Number(p.line_count ?? 0),
    receivable: d2(p.receivable ?? 0), payable: d2(p.payable ?? 0), money: d2(p.money ?? 0),
    stock: d2(p.stock ?? 0), equity: d2(p.equity ?? 0),
  };

  return {
    batch,
    lines,
    preview,
    readiness: rows<{ check_key: string; ok: boolean }>(readyRes, 'go-live readiness').map((r) => ({ key: r.check_key, ok: r.ok })),
    parties: rows<{ id: string; name: string; type: string; phone: string | null }>(partiesRes, 'parties'),
    accounts: rows<{ id: string; name: string }>(accountsRes, 'money accounts'),
    items: rows<{ id: string; name: string; brand: string | null; base_uom: string }>(itemsRes, 'items').map((i) => ({ id: i.id, name: i.name, brand: i.brand, baseUom: i.base_uom })),
    godowns: rows<{ id: string; name: string }>(godownsRes, 'godowns'),
    defaultDate: todayIn(timeZone, new Date(Date.now() - 86_400_000)),
  };
}
