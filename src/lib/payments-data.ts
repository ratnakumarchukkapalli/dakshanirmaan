import 'server-only';
import { addDecimal, decimalText } from '@/lib/decimal';
import { todayIn } from '@/lib/format';
import type { FormAccount, OpenInvoiceForAlloc, PaymentFormContext, PaymentListRow, PaymentParty, PaymentTiles } from '@/lib/payments-types';
import { containsPattern, quoteFilterValue } from '@/lib/search';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;

// The database returns NUMERIC columns as JSON numbers; they are turned back into exact decimal
// strings here (toFixed on the column's own scale), never computed with.
const dec = (v: unknown, dp: number) => decimalText(v as number | string | null, dp);

/**
 * Everything the payment form needs to pick from: every party who can receive or be paid, the
 * money accounts, and every open invoice on both books (sales for a receipt, purchase for a
 * payment) — loaded once, filtered client-side by the chosen party and direction, same pattern
 * as the invoice/challan forms. `keepPartyId` is an existing draft's party: stays selectable even
 * if disabled since.
 */
export async function loadPaymentFormContext(supabase: Supabase, isAdmin: boolean, keepPartyId?: string): Promise<PaymentFormContext> {
  const [orgRes, partiesRes, balRes, accRes, openSalesRes, openPurchaseRes] = await Promise.all([
    supabase.from('organization').select('timezone').maybeSingle(),
    supabase.from('parties').select('id, name, type, is_active').in('type', ['customer', 'supplier', 'both']).order('name'),
    supabase.from('v_party_balances').select('party_id, ar_balance, ap_balance'),
    supabase.from('accounts').select('id, name, system_key').eq('is_money', true).eq('is_group', false).order('code'),
    supabase.from('v_open_sales_invoices').select('invoice_id, party_id, invoice_no, invoice_date, age_days, open_amount'),
    supabase.from('v_open_purchase_invoices').select('invoice_id, party_id, invoice_no, invoice_date, age_days, open_amount'),
  ]);

  const balances = new Map((balRes.data ?? []).map((b) => [b.party_id as string, b]));
  const parties: PaymentParty[] = (partiesRes.data ?? [])
    .filter((p) => p.is_active || p.id === keepPartyId)
    .map((p) => {
      const b = balances.get(p.id);
      return {
        id: p.id, name: p.name, type: p.type as PaymentParty['type'], isActive: p.is_active,
        arBalance: b ? dec(b.ar_balance, 2) : '0.00', apBalance: b ? dec(b.ap_balance, 2) : '0.00',
      };
    });

  const accounts: FormAccount[] = (accRes.data ?? []).map((a) => ({ id: a.id, name: a.name, systemKey: a.system_key }));

  const openInvoices: OpenInvoiceForAlloc[] = [
    ...(openSalesRes.data ?? []).map((r) => ({
      invoiceType: 'sales_invoice' as const, invoiceId: r.invoice_id as string, partyId: r.party_id as string,
      docNo: r.invoice_no as string, docDate: r.invoice_date as string, ageDays: r.age_days as number, openAmount: dec(r.open_amount, 2),
    })),
    ...(openPurchaseRes.data ?? []).map((r) => ({
      invoiceType: 'purchase_invoice' as const, invoiceId: r.invoice_id as string, partyId: r.party_id as string,
      docNo: r.invoice_no as string, docDate: r.invoice_date as string, ageDays: r.age_days as number, openAmount: dec(r.open_amount, 2),
    })),
  ];

  return {
    parties, accounts, openInvoices, isAdmin,
    today: todayIn(orgRes.data?.timezone ?? 'Asia/Kolkata'),
  };
}

/** `cheque_status` value -> the `payments.*` message key for its chip. */
const CHEQUE_LABEL: Record<string, string> = {
  in_hand: 'statusInHand', deposited: 'statusDeposited', cleared: 'statusCleared',
  bounced: 'statusBounced', issued: 'statusIssued', presented: 'statusPresented',
};

/** The payments list rows plus the four summary tiles, for `/payments`. */
export async function loadPaymentsList(
  supabase: Supabase,
  filter: { direction?: 'receipt' | 'payment'; draftOnly?: boolean; q?: string },
): Promise<{ rows: PaymentListRow[]; tiles: PaymentTiles }> {
  let query = supabase
    .from('payments')
    .select('id, voucher_no, direction, payment_date, mode, instrument_no, cheque_bank, amount, status, cheque_status, party:parties(name)')
    .order('payment_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200);
  if (filter.direction) query = query.eq('direction', filter.direction);
  if (filter.draftOnly) query = query.eq('status', 'draft');
  if (filter.q) {
    // Voucher number or party name, same escaping as the sales/challans lists.
    const pattern = quoteFilterValue(containsPattern(filter.q));
    const { data: matches } = await supabase.from('parties').select('id').ilike('name', containsPattern(filter.q)).limit(200);
    const ids = (matches ?? []).map((p) => p.id as string);
    query = query.or([`voucher_no.ilike.${pattern}`, ...(ids.length ? [`party_id.in.(${ids.join(',')})`] : [])].join(','));
  }
  const { data: payRows } = await query;

  const ids = (payRows ?? []).map((p) => p.id as string);
  const { data: allocRows } = ids.length
    ? await supabase.from('payment_allocations').select('payment_id, invoice_type, invoice_id').in('payment_id', ids)
    : { data: [] as { payment_id: string; invoice_type: string; invoice_id: string }[] };

  const refIds = { sales_invoice: new Set<string>(), purchase_invoice: new Set<string>() };
  for (const a of allocRows ?? []) refIds[a.invoice_type as 'sales_invoice' | 'purchase_invoice'].add(a.invoice_id as string);

  const [salesRefs, purchaseRefs] = await Promise.all([
    refIds.sales_invoice.size
      ? supabase.from('sales_invoices').select('id, invoice_no').in('id', [...refIds.sales_invoice])
      : Promise.resolve({ data: [] as { id: string; invoice_no: string | null }[] }),
    refIds.purchase_invoice.size
      ? supabase.from('purchase_invoices').select('id, invoice_no').in('id', [...refIds.purchase_invoice])
      : Promise.resolve({ data: [] as { id: string; invoice_no: string | null }[] }),
  ]);
  const docNo = new Map<string, string>([
    ...(salesRefs.data ?? []).map((r) => [r.id as string, r.invoice_no ?? ''] as const),
    ...(purchaseRefs.data ?? []).map((r) => [r.id as string, r.invoice_no ?? ''] as const),
  ]);
  const refsByPayment = new Map<string, string[]>();
  for (const a of allocRows ?? []) {
    const key = a.payment_id as string;
    const ref = docNo.get(a.invoice_id as string);
    if (ref) refsByPayment.set(key, [...(refsByPayment.get(key) ?? []), ref]);
  }

  const rows: PaymentListRow[] = (payRows ?? []).map((p) => ({
    id: p.id as string,
    voucherNo: p.voucher_no as string | null,
    direction: p.direction as 'receipt' | 'payment',
    paymentDate: p.payment_date as string,
    partyName: (p.party as unknown as { name: string } | null)?.name ?? '—',
    mode: p.mode as PaymentListRow['mode'],
    instrumentNo: p.instrument_no as string | null,
    chequeBank: p.cheque_bank as string | null,
    amount: dec(p.amount, 2),
    status: p.status as PaymentListRow['status'],
    chequeStatus: (p.cheque_status as string | null) as PaymentListRow['chequeStatus'],
    allocatedRefs: refsByPayment.get(p.id as string) ?? [],
  }));

  const tiles = await loadPaymentTiles(supabase);
  return { rows, tiles };
}

async function loadPaymentTiles(supabase: Supabase): Promise<PaymentTiles> {
  const { data: org } = await supabase.from('organization').select('timezone').maybeSingle();
  const today = todayIn(org?.timezone ?? 'Asia/Kolkata');

  const [receivedRes, inHandRes, issuedRes, postedRes, allocRes] = await Promise.all([
    supabase.from('payments').select('amount').eq('direction', 'receipt').eq('status', 'posted').eq('payment_date', today),
    supabase.from('payments').select('amount').eq('status', 'posted').eq('mode', 'cheque').eq('cheque_status', 'in_hand'),
    supabase.from('payments').select('amount').eq('status', 'posted').eq('direction', 'payment').eq('mode', 'cheque').in('cheque_status', ['issued', 'presented']),
    supabase.from('payments').select('id, amount, discount').eq('status', 'posted'),
    supabase.from('payment_allocations').select('payment_id, amount'),
  ]);

  // Exact-decimal sums throughout: these are display aggregations of already-posted amounts,
  // never a new financial truth, but still money — no `Number` arithmetic on it.
  const sum = (rows: { amount: unknown }[] | null) => (rows ?? []).reduce((s, r) => addDecimal(s, dec(r.amount, 2), 2) ?? s, '0.00');

  const allocByPayment = new Map<string, string>();
  for (const a of allocRes.data ?? []) {
    const key = a.payment_id as string;
    allocByPayment.set(key, addDecimal(allocByPayment.get(key) ?? '0.00', dec(a.amount, 2), 2) ?? '0.00');
  }
  const unallocated = (postedRes.data ?? []).reduce((s, p) => {
    // Allocations may total amount + discount (the database's cap), so that is what is left to place.
    const settle = addDecimal(dec(p.amount, 2), dec(p.discount, 2), 2) ?? '0.00';
    const remainder = addDecimal(settle, `-${allocByPayment.get(p.id as string) ?? '0.00'}`, 2) ?? '0.00';
    return remainder.startsWith('-') ? s : addDecimal(s, remainder, 2) ?? s;
  }, '0.00');

  return {
    receivedToday: sum(receivedRes.data),
    chequesInHand: sum(inHandRes.data),
    chequesIssued: sum(issuedRes.data),
    unallocated,
  };
}

export { CHEQUE_LABEL };
