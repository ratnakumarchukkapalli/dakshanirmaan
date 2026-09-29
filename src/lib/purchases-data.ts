import 'server-only';
import { completeRows, one, rows } from '@/lib/db';
import { addDecimal, decimalText, negateDecimal } from '@/lib/decimal';
import { todayIn } from '@/lib/format';
import type { BillFormContext, BillItem, BillSupplier } from '@/lib/purchases-types';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;

const dec = (v: unknown, dp: number) => decimalText(v as number | string | null, dp);

/**
 * Everything the bill form picks from. `keep` is what an existing draft already carries: that
 * supplier and those items stay selectable even if disabled since (a new draft offers active
 * suppliers and active stock items only).
 */
export async function loadBillFormContext(
  supabase: Supabase,
  keep: { partyId?: string; itemIds?: string[] } = {},
): Promise<BillFormContext> {
  const [orgRes, partiesRes, balRes, itemsRes] = await Promise.all([
    supabase.from('organization').select('state_code, timezone').maybeSingle(),
    supabase.from('parties').select('id, name, gstin, state_code, is_active').in('type', ['supplier', 'both']).order('name'),
    supabase.from('v_party_balances').select('party_id, ap_balance'),
    supabase.from('items')
      .select('id, name, brand, hsn_code, gst_rate, base_uom, alt_uom, conversion_factor, is_active')
      .eq('is_stock', true).order('name'),
  ]);
  const org = one<{ state_code: string; timezone: string }>(orgRes, 'organisation');
  const owed = new Map(rows<{ party_id: string; ap_balance: number }>(balRes, 'party balances').map((b) => [b.party_id, dec(b.ap_balance, 2)]));

  const suppliers: BillSupplier[] = rows<{ id: string; name: string; gstin: string | null; state_code: string; is_active: boolean }>(partiesRes, 'suppliers')
    .filter((p) => p.is_active || p.id === keep.partyId)
    .map((p) => ({ id: p.id, name: p.name, gstin: p.gstin, stateCode: p.state_code, isActive: p.is_active, owed: owed.get(p.id) ?? '0.00' }));

  const wanted = new Set(keep.itemIds ?? []);
  const items: BillItem[] = rows<{
    id: string; name: string; brand: string | null; hsn_code: string; gst_rate: number; base_uom: string;
    alt_uom: string | null; conversion_factor: number | null; is_active: boolean;
  }>(itemsRes, 'items')
    .filter((i) => i.is_active || wanted.has(i.id))
    .map((i) => ({
      id: i.id, name: i.name, brand: i.brand, hsn: i.hsn_code, gstRate: dec(i.gst_rate, 2), baseUom: i.base_uom, altUom: i.alt_uom,
      factor: i.conversion_factor === null ? null : dec(i.conversion_factor, 4), isActive: i.is_active,
    }));

  const timeZone = org?.timezone ?? 'Asia/Kolkata';
  return { suppliers, items, orgState: org?.state_code ?? '37', today: todayIn(timeZone) };
}

export interface PurchaseTiles {
  /** Owed to suppliers on posted bills not yet settled (open amount, after payments and debit notes). */
  payable: string;
  /** Input tax credit sitting in the three input-tax ledgers (net of what has been used). */
  itc: string;
  /** Reverse-charge tax we owe on freight (the RCM payable ledger). */
  rcmPayable: string;
}

/** The three list tiles. The tax ledgers come from the owner-only trial balance; this screen is owner-only. */
export async function loadPurchaseTiles(supabase: Supabase): Promise<PurchaseTiles> {
  const [openRes, tbRes] = await Promise.all([
    supabase.from('v_open_purchase_invoices').select('open_amount', { count: 'exact' }),
    supabase.from('v_trial_balance').select('system_key, closing').in('system_key', ['input_cgst', 'input_sgst', 'input_igst', 'rcm_payable']),
  ]);
  const sum = (values: unknown[]) => values.reduce<string>((s, v) => addDecimal(s, dec(v, 2), 2) ?? s, '0.00');
  // A total over a list the server cut short would be wrong without looking wrong: completeRows throws instead.
  const open = completeRows<{ open_amount: number }>(openRes, 'open bills');
  const tb = rows<{ system_key: string; closing: number }>(tbRes, 'tax ledgers');
  // v_trial_balance answers nothing at all to anyone who is not a verified owner: an empty answer must not read as "0".
  if (['input_cgst', 'input_sgst', 'input_igst', 'rcm_payable'].some((k) => !tb.some((r) => r.system_key === k))) {
    throw new Error('tax ledgers: an expected ledger was not returned');
  }
  const closing = (keys: string[]) => sum(tb.filter((r) => keys.includes(r.system_key)).map((r) => r.closing));
  // closing = debit - credit: input tax is a debit balance (credit we may claim); rcm_payable is a credit balance (what we owe).
  return {
    payable: sum(open.map((r) => r.open_amount)),
    itc: closing(['input_cgst', 'input_sgst', 'input_igst']),
    rcmPayable: negateDecimal(closing(['rcm_payable'])),
  };
}
