// Pure display arithmetic for the stock screens. Exact decimals throughout (scaled BigInts): the
// figures come from the stock views; this only adds them up across godowns and derives the same
// weighted average the view does (round(value / qty, 4), 0 when nothing is on hand).
import { formatScaled, parseScaled, roundDiv } from '@/lib/decimal';

export interface StockFigure {
  /** NUMERIC(12,3) text. */
  qty: string;
  /** NUMERIC(14,2) text; absent for a counter session (cost is owner-only). */
  value?: string;
}

/** A signed decimal text as a scaled BigInt; null when it is not a plain decimal with at most `dp` places. */
function signed(text: string, dp: number): bigint | null {
  const negative = text.startsWith('-');
  const n = parseScaled(negative ? text.slice(1) : text, dp);
  return n === null ? null : negative ? -n : n;
}

/** Sum of quantities (3 dp) and, when every row has one, of values (2 dp). Rows that are not plain decimals count as zero. */
export function sumStock(rows: StockFigure[]): { qty: string; value: string | null } {
  let q = 0n;
  let v = 0n;
  let hasValue = rows.length > 0;
  for (const r of rows) {
    q += signed(r.qty, 3) ?? 0n;
    if (r.value === undefined) hasValue = false;
    else v += signed(r.value, 2) ?? 0n;
  }
  return { qty: formatScaled(q, 3), value: hasValue ? formatScaled(v, 2) : null };
}

/** round(value / qty, 4) as text, 0.0000 when qty is 0 — the stock views' own formula. Null when either is not a decimal. */
export function averageRate(value: string, qty: string): string | null {
  const v = signed(value, 2);
  const q = signed(qty, 3);
  if (v === null || q === null) return null;
  if (q === 0n) return '0.0000';
  // value (2 dp) / qty (3 dp) at 4 dp = value * 10^5 / qty.
  return formatScaled(roundDiv(v * 100000n, q), 4);
}

/** Kilograms -> metric tonnes at 2 dp (11460.000 kg -> "11.46"). Null when not a decimal. */
export function kgToTonnes(kg: string): string | null {
  const q = signed(kg, 3);
  return q === null ? null : formatScaled(roundDiv(q, 10000n), 2);
}
