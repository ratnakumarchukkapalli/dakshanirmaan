// Pieces <-> base-unit helpers for items sold in two units (TMT bars: base kg, alternate pcs).
// `factor` is items.conversion_factor: 1 alt unit = `factor` base units (NUMERIC(12,4)).
// Quantities are NUMERIC(12,3). Stock and the invoice always carry the base unit; the alternate
// figure is stored beside it (sales_invoice_lines.alt_qty).
import { formatScaled, parseScaled, roundDiv } from '@/lib/decimal';

/** Pieces → base units (e.g. kg), 3 decimals; null when either number is not a plain decimal or the factor is 0. */
export function altToBase(factor: string, alt: string): string | null {
  const f = parseScaled(factor, 4);
  const a = parseScaled(alt, 3);
  if (f === null || a === null || f === 0n) return null;
  return formatScaled(roundDiv(a * f, 10_000n), 3);
}

/** Base units → pieces, 3 decimals. */
export function baseToAlt(factor: string, base: string): string | null {
  const f = parseScaled(factor, 4);
  const b = parseScaled(base, 3);
  if (f === null || b === null || f === 0n) return null;
  return formatScaled(roundDiv(b * 10_000n, f), 3);
}

/** "12.500" → "12.5", "3.000" → "3": for showing a quantity without noise. Display only. */
export function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** 385.0000 → "385.00"; 62.5375 stays: a rate shows at least 2 and at most 4 decimals. */
export function rateText(rate: string): string {
  const t = trimZeros(rate);
  const [w = '0', f = ''] = t.split('.');
  return f.length >= 2 ? t : `${w}.${f.padEnd(2, '0')}`;
}
