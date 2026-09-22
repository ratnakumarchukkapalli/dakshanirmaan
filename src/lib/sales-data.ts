import 'server-only';
import { decimalText } from '@/lib/decimal';
import { todayIn } from '@/lib/format';
import { previewTotals } from '@/lib/invoice-math';
import type { FormAccount, FormItem, FormParty, FormSite, InvoiceFormContext, OpenChallan } from '@/lib/sales-types';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;

// The database returns NUMERIC columns as JSON numbers; they are turned back into exact decimal
// strings here (toFixed on the column's own scale), never computed with.
const dec = (v: unknown, dp: number) => decimalText(v as number | string | null, dp);

/**
 * Everything the invoice form needs to pick from. `keepPartyId` / `keepItemIds` are the ones an
 * existing draft already carries: they stay selectable even if disabled since (a new draft
 * offers active customers and active items only).
 */
export async function loadInvoiceFormContext(
  supabase: Supabase,
  keep: { partyId?: string; itemIds?: string[] } = {},
): Promise<InvoiceFormContext> {
  const [orgRes, partiesRes, addrRes, balRes, itemsRes, whRes, accRes] = await Promise.all([
    supabase.from('organization').select('state_code, timezone, upi_vpa').maybeSingle(),
    supabase.from('parties').select('id, name, gstin, state_code, is_walk_in, is_active, default_site_id, credit_limit, type').in('type', ['customer', 'both']).order('name'),
    supabase.from('party_addresses').select('id, party_id, label, state_code, is_default, address'),
    supabase.from('v_party_balances').select('party_id, ar_balance'),
    supabase.from('items').select('id, name, brand, hsn_code, gst_rate, base_uom, alt_uom, conversion_factor, sale_rate, is_stock, is_active').order('name'),
    supabase.from('warehouses').select('id').eq('is_default', true).eq('is_transit', false).maybeSingle(),
    supabase.from('accounts').select('id, name, system_key').eq('is_money', true).eq('is_group', false).order('code'),
  ]);

  const stockRes = whRes.data
    ? await supabase.from('v_stock_summary').select('item_id, qty').eq('warehouse_id', whRes.data.id)
    : { data: [] as { item_id: string; qty: number }[] };
  const onHand = new Map((stockRes.data ?? []).map((s) => [s.item_id as string, dec(s.qty, 3)]));
  const balance = new Map((balRes.data ?? []).map((b) => [b.party_id as string, dec(b.ar_balance, 2)]));

  const sitesByParty = new Map<string, FormSite[]>();
  for (const a of addrRes.data ?? []) {
    const ad = (a.address ?? {}) as Record<string, string | null>;
    const site: FormSite = {
      id: a.id, label: a.label, line1: ad.line1 ?? '', city: ad.city ?? '', pincode: ad.pincode ?? '',
      stateCode: a.state_code, isBilling: a.is_default,
    };
    sitesByParty.set(a.party_id, [...(sitesByParty.get(a.party_id) ?? []), site]);
  }

  const parties: FormParty[] = (partiesRes.data ?? [])
    .filter((p) => p.is_active || p.id === keep.partyId)
    .map((p) => ({
      id: p.id, name: p.name, gstin: p.gstin, stateCode: p.state_code, isWalkIn: p.is_walk_in, isActive: p.is_active,
      defaultSiteId: p.default_site_id,
      creditLimit: p.credit_limit === null ? null : dec(p.credit_limit, 2),
      balance: balance.get(p.id) ?? '0.00',
      sites: sitesByParty.get(p.id) ?? [],
    }));

  const wanted = new Set(keep.itemIds ?? []);
  const items: FormItem[] = (itemsRes.data ?? [])
    .filter((i) => i.is_active || wanted.has(i.id))
    .map((i) => ({
      id: i.id, name: i.name, brand: i.brand, hsn: i.hsn_code, gstRate: dec(i.gst_rate, 2), baseUom: i.base_uom, altUom: i.alt_uom,
      factor: i.conversion_factor === null ? null : dec(i.conversion_factor, 4), saleRate: dec(i.sale_rate, 4),
      isStock: i.is_stock, isActive: i.is_active, onHand: onHand.get(i.id) ?? '0.000',
    }));

  const accounts: FormAccount[] = (accRes.data ?? []).map((a) => ({ id: a.id, name: a.name, systemKey: a.system_key }));
  const timeZone = orgRes.data?.timezone ?? 'Asia/Kolkata';
  return { parties, items, accounts, orgState: orgRes.data?.state_code ?? '37', today: todayIn(timeZone), hasUpi: !!orgRes.data?.upi_vpa };
}

/**
 * Posted challans nobody has invoiced yet (invoice_id is null): the "Open challans" panel next to
 * the challan form, and the source list for "Invoice ->". A challan already reopened by an
 * invoice cancellation shows up here again, same as it did the first time.
 */
export async function loadOpenChallans(supabase: Supabase): Promise<OpenChallan[]> {
  // `delivery_challans` has two FKs to `parties` (party_id, driver_party_id), so the embed needs
  // the explicit constraint name -- PostgREST refuses an ambiguous `parties(name)` outright.
  const { data: rows, error } = await supabase
    .from('delivery_challans')
    .select('id, challan_no, challan_date, party:parties!delivery_challans_party_id_fkey(name)')
    .eq('status', 'posted').is('invoice_id', null)
    .order('challan_date', { ascending: false });
  if (error) { console.error('[sales-data] loadOpenChallans:', error.message); return []; }
  const challans = rows ?? [];
  if (challans.length === 0) return [];

  const ids = challans.map((c) => c.id as string);
  const { data: lines } = await supabase.from('delivery_challan_lines').select('challan_id, qty, rate, discount_pct').in('challan_id', ids);
  const linesByChallan = new Map<string, { qty: string; rate: string; discountPct: string; gstRate: string }[]>();
  for (const l of lines ?? []) {
    const key = l.challan_id as string;
    linesByChallan.set(key, [
      ...(linesByChallan.get(key) ?? []),
      { qty: dec(l.qty, 3), rate: dec(l.rate, 4), discountPct: dec(l.discount_pct, 2), gstRate: '0' },
    ]);
  }
  // Exact-decimal arithmetic, same rounding rule as the database's own line `value` column
  // (qty * rate * (1 - discount / 100), 2dp): `previewTotals`'s `taxable` is that same formula.
  const value = new Map<string, string>();
  for (const [id, ls] of linesByChallan) value.set(id, previewTotals(ls, true).taxable);

  return challans.map((c) => ({
    id: c.id as string,
    challanNo: c.challan_no as string,
    challanDate: c.challan_date as string,
    partyName: (c.party as unknown as { name: string } | null)?.name ?? '—',
    value: value.get(c.id as string) ?? '0.00',
  }));
}
