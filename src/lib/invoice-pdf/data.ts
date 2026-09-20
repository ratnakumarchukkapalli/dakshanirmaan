import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decimalText, addDecimal, compareDecimal } from '@/lib/decimal';

// Everything the invoice PDF prints, read from what the database stored: the invoice header, its
// snapshot line columns and stored totals. Nothing is recomputed except summing stored figures
// that already are on the document (line amount = taxable + its own tax; open amount = total
// less posted receipts), all in exact decimals.

export interface PdfAddress { label?: string; line1?: string; line2?: string | null; city?: string; pincode?: string; state_code?: string }

export interface InvoicePdfData {
  number: string;
  date: string;
  cancelled: boolean;
  placeOfSupply: string;
  intra: boolean;
  org: {
    legalName: string; tradeName: string | null; gstin: string | null; stateCode: string;
    address: PdfAddress | null; upiVpa: string | null; bankDetails: string | null; footer: string | null;
  };
  party: { name: string; gstin: string | null };
  billing: PdfAddress | null;
  shipping: PdfAddress | null;
  transport: {
    vehicleNo: string | null; transporterName: string | null; transporterGstin: string | null; mode: string | null;
    distanceKm: number | null; ewbNo: string | null; ewbDate: string | null; ewbValidUntil: string | null;
  };
  lines: {
    no: number; name: string; hsn: string; uom: string; qty: string; altQty: string | null; rate: string;
    discountPct: string; taxable: string; gstRate: string; tax: string; amount: string;
  }[];
  totals: { taxable: string; cgst: string; sgst: string; igst: string; roundOff: string; grand: string };
  /** Grand total less posted receipts allocated to this invoice, 2 decimals. */
  open: string;
}

export type LoadResult =
  | { kind: 'ok'; data: InvoicePdfData }
  | { kind: 'not_found' }
  | { kind: 'draft' }
  | { kind: 'error' };

const d2 = (v: unknown) => decimalText(v as number | string | null, 2);
const sum = (...parts: string[]) => parts.reduce((s, p) => addDecimal(s, p, 2) ?? s, '0.00');

/** Loads one invoice. With a user client, row-level security decides who may see it; with the service client the caller has already proved access. */
export async function loadInvoicePdfData(supabase: SupabaseClient, id: string): Promise<LoadResult> {
  const [inv, lines, org, allocs] = await Promise.all([
    supabase.from('sales_invoices').select('*, party:parties(name, gstin)').eq('id', id).maybeSingle(),
    supabase.from('sales_invoice_lines')
      .select('line_no, item_name, hsn_code, uom, qty, alt_qty, rate, discount_pct, taxable_value, gst_rate, cgst_amt, sgst_amt, igst_amt')
      .eq('invoice_id', id).order('line_no'),
    supabase.from('organization').select('legal_name, trade_name, gstin, state_code, address, upi_vpa, invoice_bank_details, invoice_footer').maybeSingle(),
    supabase.from('payment_allocations')
      .select('amount, payment:payments(status)')
      .eq('invoice_type', 'sales_invoice').eq('invoice_id', id),
  ]);
  if (inv.error || lines.error || org.error || allocs.error) {
    console.error('[invoice-pdf] read failed:', inv.error?.message ?? lines.error?.message ?? org.error?.message ?? allocs.error?.message);
    return { kind: 'error' };
  }
  const h = inv.data;
  if (!h || !org.data) return { kind: 'not_found' };
  if (h.status === 'draft') return { kind: 'draft' };

  const o = org.data;
  const party = h.party as { name: string; gstin: string | null } | null;
  const received = sum(
    ...(allocs.data ?? [])
      .filter((a) => (a.payment as unknown as { status: string } | null)?.status === 'posted')
      .map((a) => d2(a.amount)),
  );
  const grand = d2(h.grand_total);
  const owing = addDecimal(grand, `-${received}`, 2) ?? grand;

  return {
    kind: 'ok',
    data: {
      number: h.invoice_no as string,
      date: h.invoice_date as string,
      cancelled: h.status === 'cancelled',
      placeOfSupply: h.place_of_supply as string,
      intra: h.place_of_supply === o.state_code,
      org: {
        legalName: o.legal_name, tradeName: o.trade_name, gstin: o.gstin, stateCode: o.state_code,
        address: o.address as PdfAddress | null, upiVpa: o.upi_vpa, bankDetails: o.invoice_bank_details, footer: o.invoice_footer,
      },
      party: { name: party?.name ?? '', gstin: party?.gstin ?? null },
      billing: h.billing_address as PdfAddress | null,
      shipping: h.shipping_address as PdfAddress | null,
      transport: {
        vehicleNo: h.vehicle_no, transporterName: h.transporter_name, transporterGstin: h.transporter_gstin, mode: h.transport_mode,
        distanceKm: h.distance_km, ewbNo: h.ewb_no, ewbDate: h.ewb_date, ewbValidUntil: h.ewb_valid_until,
      },
      lines: (lines.data ?? []).map((l) => {
        const tax = sum(d2(l.cgst_amt), d2(l.sgst_amt), d2(l.igst_amt));
        return {
          no: l.line_no, name: l.item_name, hsn: l.hsn_code, uom: l.uom,
          qty: decimalText(l.qty, 3), altQty: l.alt_qty === null ? null : decimalText(l.alt_qty, 3),
          rate: decimalText(l.rate, 4), discountPct: decimalText(l.discount_pct, 2), taxable: d2(l.taxable_value),
          gstRate: decimalText(l.gst_rate, 2), tax, amount: sum(d2(l.taxable_value), tax),
        };
      }),
      totals: {
        taxable: d2(h.taxable_total), cgst: d2(h.cgst_total), sgst: d2(h.sgst_total), igst: d2(h.igst_total),
        roundOff: d2(h.round_off), grand,
      },
      open: compareDecimal(owing, '0.00', 2) === -1 ? '0.00' : owing,
    },
  };
}
