// Invoice totals PREVIEW. The database recomputes every figure from the saved line snapshots when
// an invoice is posted and is the only source of truth; this exists so the billing screen can show
// a live total before saving. It mirrors `_post_sales_invoice` (migration
// 20260918140100_posting_challan_transfer_adjust_dayclose.sql) rounding rule for rule, in exact
// integer arithmetic (paise as BigInt):
//
//   taxable  = round(qty * rate * (1 - discount_pct / 100), 2)                      per line
//   intra    : cgst = round(taxable * gst_rate / 2 / 100, 2); sgst = cgst; igst = 0   per line
//   inter    : cgst = sgst = 0; igst = round(taxable * gst_rate / 100, 2)             per line
//   raw      = sum(taxable) + sum(cgst) + sum(sgst) + sum(igst)
//   grand    = round(raw)          (whole rupees)
//   round_off = grand - raw
//
// `round` is half away from zero (Postgres numeric). Intra-state = place of supply equals the
// organisation's state. Nothing here is ever sent to the database as a total.
import { formatScaled, parseScaled, roundDiv } from '@/lib/decimal';

export interface PreviewLine {
  qty: string;
  rate: string;
  discountPct: string;
  gstRate: string;
}

export interface PreviewLineResult {
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
}

export interface PreviewTotals {
  lines: (PreviewLineResult | null)[];
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  roundOff: string;
  grandTotal: string;
}

const RUPEE = 100n; // paise per rupee

/** One line's amounts in paise, or null while any of its numbers is missing or malformed. */
function lineAmounts(line: PreviewLine, intra: boolean) {
  const qty = parseScaled(line.qty, 3); // NUMERIC(12,3), scale 1e3
  const rate = parseScaled(line.rate, 4); // NUMERIC(14,4), scale 1e4
  const disc = parseScaled(line.discountPct === '' ? '0' : line.discountPct, 2); // NUMERIC(5,2), scale 1e2
  const gst = parseScaled(line.gstRate, 2); // NUMERIC(5,2), scale 1e2
  if (qty === null || rate === null || disc === null || gst === null || disc > 10000n) return null;

  // qty*rate*(100 - disc) has scale 1e3*1e4*1e2 = 1e9; dividing by 100 makes it 1e11 rupees = 1e9 paise.
  const taxable = roundDiv(qty * rate * (10000n - disc), 1_000_000_000n);
  // taxable (paise, 1e2) * gst (1e2): dividing by 200 (intra) or 100 (inter) then to paise → 20000 / 10000.
  if (intra) {
    const cgst = roundDiv(taxable * gst, 20000n);
    return { taxable, cgst, sgst: cgst, igst: 0n };
  }
  return { taxable, cgst: 0n, sgst: 0n, igst: roundDiv(taxable * gst, 10000n) };
}

export function previewTotals(lines: PreviewLine[], intra: boolean): PreviewTotals {
  let taxable = 0n, cgst = 0n, sgst = 0n, igst = 0n;
  const results = lines.map((line) => {
    const a = lineAmounts(line, intra);
    if (!a) return null;
    taxable += a.taxable; cgst += a.cgst; sgst += a.sgst; igst += a.igst;
    return {
      taxable: formatScaled(a.taxable, 2), cgst: formatScaled(a.cgst, 2),
      sgst: formatScaled(a.sgst, 2), igst: formatScaled(a.igst, 2),
    };
  });
  const raw = taxable + cgst + sgst + igst;
  const grand = roundDiv(raw, RUPEE) * RUPEE;
  return {
    lines: results,
    taxable: formatScaled(taxable, 2), cgst: formatScaled(cgst, 2), sgst: formatScaled(sgst, 2), igst: formatScaled(igst, 2),
    roundOff: formatScaled(grand - raw, 2), grandTotal: formatScaled(grand, 2),
  };
}
