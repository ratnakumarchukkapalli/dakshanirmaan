import { formatScaled, parseScaled, roundDiv } from '@/lib/decimal';

// Exact decimals for the export layer. The database's NUMERIC values are read as text (`col::text`
// in the select) and kept as text; sums are BigInt over the scaled integer, so no float arithmetic
// ever touches a figure. A number only appears at the very last step: a spreadsheet cell.

const PLAIN = /^-?\d+(\.\d+)?$/;

/**
 * A NUMERIC value as canonical decimal text with exactly `dp` places. Accepts the text PostgREST sends
 * for a `::text` cast, or (for jsonb and RPC columns that arrive as JSON numbers) a number that is
 * exactly representable at `dp` places. Anything that would have to be rounded is an error: an export
 * must never quietly change a figure.
 */
export function decimalString(value: string | number | null | undefined, dp: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`export: not a finite number: ${value}`);
    const text = value.toFixed(dp);
    if (Number(text) !== value) throw new Error(`export: ${value} does not fit ${dp} decimal places`);
    return normaliseZero(text);
  }
  const t = value.trim();
  if (!PLAIN.test(t)) throw new Error(`export: not a plain decimal: ${value}`);
  const negative = t.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? t.slice(1) : t).split('.');
  const extra = frac.slice(dp);
  if (/[^0]/.test(extra)) throw new Error(`export: ${value} does not fit ${dp} decimal places`);
  const body = dp > 0 ? `${whole.replace(/^0+(?=\d)/, '')}.${frac.slice(0, dp).padEnd(dp, '0')}` : whole.replace(/^0+(?=\d)/, '');
  return normaliseZero(negative ? `-${body}` : body);
}

/** "-0.00" is just "0.00". */
const normaliseZero = (t: string) => (/^-0(\.0+)?$/.test(t) ? t.slice(1) : t);

/** Signed decimal text -> scaled BigInt (1234.5 at dp 2 -> 123450n). */
export function toScaled(text: string, dp: number): bigint {
  const negative = text.startsWith('-');
  const v = parseScaled(negative ? text.slice(1) : text, dp);
  if (v === null) throw new Error(`export: not a decimal with at most ${dp} places: ${text}`);
  return negative ? -v : v;
}

export const fromScaled = (value: bigint, dp: number): string => normaliseZero(formatScaled(value, dp));

/** Adds decimal texts exactly. */
export function sumDecimal(values: Iterable<string>, dp: number): string {
  let total = 0n;
  for (const v of values) total += toScaled(v, dp);
  return fromScaled(total, dp);
}

/** value / qty at `dp` places, half away from zero (Postgres round()); null when qty is zero. */
export function divideDecimal(value: bigint, qty: bigint, valueDp: number, qtyDp: number, dp: number): string | null {
  if (qty === 0n) return null;
  // (value / 10^valueDp) / (qty / 10^qtyDp) * 10^dp  =  value * 10^(qtyDp + dp) / (qty * 10^valueDp)
  const num = value * 10n ** BigInt(qtyDp + dp);
  const den = qty * 10n ** BigInt(valueDp);
  return fromScaled(roundDiv(num, den), dp);
}

/**
 * The spreadsheet number for a decimal text: Number(text), but only when the JavaScript number prints
 * back as exactly the same digits (every 2/3/4-place amount below ~10^11 does). The file then holds
 * `<v>1234567.89</v>`, the database's digits, not a rounded approximation. Returns null when it would
 * not round-trip; the writer then keeps the text.
 */
export function exactCellNumber(text: string): number | null {
  if (!PLAIN.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const canonical = (t: string) => {
    const neg = t.startsWith('-');
    const [w = '0', f = ''] = (neg ? t.slice(1) : t).split('.');
    const body = `${w.replace(/^0+(?=\d)/, '')}${f.replace(/0+$/, '') ? `.${f.replace(/0+$/, '')}` : ''}`;
    return body === '' ? '0' : neg && body !== '0' ? `-${body}` : body;
  };
  const printed = String(n);
  if (/e/i.test(printed)) return null;
  return canonical(printed) === canonical(text) ? n : null;
}
