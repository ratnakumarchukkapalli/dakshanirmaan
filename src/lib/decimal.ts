// Exact decimal helpers for previews. Decimal strings become scaled BigInts, so there is never a
// float in the arithmetic (0.1 + 0.2 style drift would corrupt a bill). Only non-negative values
// are handled: quantities, rates, discounts and tax rates are never negative on an invoice.

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** "62.5" with dp 4 → 625000n. Null when the text is not a plain non-negative decimal with at most `dp` places. */
export function parseScaled(text: string, dp: number): bigint | null {
  const t = text.trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${dp}})?$`).test(t)) return null;
  const [whole = '0', frac = ''] = t.split('.');
  return BigInt(whole) * pow10(dp) + BigInt(frac.padEnd(dp, '0') || '0');
}

/** 625000n with dp 4 → "62.5000". */
export function formatScaled(value: bigint, dp: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / pow10(dp);
  const frac = (abs % pow10(dp)).toString().padStart(dp, '0');
  return `${negative ? '-' : ''}${whole}${dp > 0 ? `.${frac}` : ''}`;
}

/** num / den rounded half away from zero (what Postgres `round()` does on numeric). */
export function roundDiv(num: bigint, den: bigint): bigint {
  const negative = num < 0n !== den < 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = (n + d / 2n) / d;
  return negative ? -q : q;
}

/** A NUMERIC text (or number from PostgREST) at exactly `dp` places, without parsing floats. */
export function decimalText(value: string | number | null | undefined, dp: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return value.toFixed(dp);
}

/** -1 / 0 / 1 comparing two decimal texts at `dp` places; null when either is not a plain decimal. */
export function compareDecimal(a: string, b: string, dp: number): -1 | 0 | 1 | null {
  const x = parseScaled(a, dp);
  const y = parseScaled(b, dp);
  if (x === null || y === null) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Adds two non-negative decimal texts at `dp` places. Balances can be negative, so a leading '-' is handled. */
export function addDecimal(a: string, b: string, dp: number): string | null {
  const signed = (t: string) => (t.startsWith('-') ? (parseScaled(t.slice(1), dp) ?? null) : parseScaled(t, dp));
  const x = signed(a);
  const y = signed(b);
  if (x === null || y === null) return null;
  return formatScaled((a.startsWith('-') ? -x : x) + (b.startsWith('-') ? -y : y), dp);
}

/** -1 / 0 / 1 for a signed decimal text ("-12.50", "0.00", "3"); 0 for anything that is not a plain decimal. */
export function signOf(text: string | null | undefined): -1 | 0 | 1 {
  const t = (text ?? '').trim();
  const negative = t.startsWith('-');
  const digits = negative ? t.slice(1) : t;
  if (!/^\d+(\.\d+)?$/.test(digits) || /^0+(\.0+)?$/.test(digits)) return 0;
  return negative ? -1 : 1;
}

/** Negates a plain decimal text ("12.50" -> "-12.50", "-3" -> "3", "0.00" stays "0.00"). */
export function negateDecimal(text: string): string {
  if (signOf(text) === 0) return text;
  return text.startsWith('-') ? text.slice(1) : `-${text}`;
}

/** a - b at `dp` places, for texts that may be negative; null when either is not a plain decimal. */
export function subtractDecimal(a: string, b: string, dp: number): string | null {
  return addDecimal(a, negateDecimal(b), dp);
}

/**
 * days x rate: an integer-or-half-day count (`days`, up to 1 decimal) times a rate (up to 2 decimals)
 * -> an amount at 2 decimals, half away from zero. Null when either is not a plain decimal.
 */
export function multiplyDays(days: string, rate: string): string | null {
  const d = parseScaled(days, 1);
  const r = parseScaled(rate, 2);
  if (d === null || r === null) return null;
  return formatScaled(roundDiv(d * r, 10n), 2);
}
