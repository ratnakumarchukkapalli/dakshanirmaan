// Display helpers. Dates travel as ISO strings (YYYY-MM-DD); nothing here parses them
// through Date, so the viewer's time zone can never shift a business date.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(iso: string): { y: number; m: number; d: number } {
  const match = ISO_DATE.exec(iso);
  if (!match) throw new Error(`Not an ISO date: ${iso}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`Not an ISO date: ${iso}`);
  return { y, m, d };
}

/** Today's business date (YYYY-MM-DD) in the organisation's time zone — never the server's. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** ISO date → DD-MM-YYYY. */
export function formatDate(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}`;
}

/** Financial-year label for a date: April–March by default, so 2026-09-19 → '26-27'. */
export function fyLabel(iso: string, fyStartMonth = 4): string {
  const { y, m } = parts(iso);
  const startYear = m >= fyStartMonth ? y : y - 1;
  const yy = (n: number) => String(n % 100).padStart(2, '0');
  return `${yy(startYear)}-${yy(startYear + 1)}`;
}

const inrWhole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inrPaise = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ₹1,23,456 — whole rupees, for display only (the ledger is authoritative). */
export function inr(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return `${n < 0 ? '-' : ''}₹${inrWhole.format(Math.abs(n))}`;
}

/** ₹1,23,456.50 — with paise, for tax rows. */
export function inr2(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return `${n < 0 ? '-' : ''}₹${inrPaise.format(Math.abs(n))}`;
}

const inrUnitRate = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** ₹62.50 / ₹62.5375 — a per-unit rate (NUMERIC(14,4)): at least 2 and at most 4 decimals, never rounded to rupees. */
export function inrRate(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return `${n < 0 ? '-' : ''}₹${inrUnitRate.format(Math.abs(n))}`;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0-999 in words ('' for 0). */
function belowThousand(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) parts.push(TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]}` : ''));
  else if (n > 0) parts.push(ONES[n]!);
  return parts.join(' ');
}

/** A whole number (digits only, as a string) in the Indian system: Crore, Lakh, Thousand. */
function indianWords(digits: string): string {
  const s = digits.replace(/^0+(?=\d)/, '');
  if (s === '0') return 'Zero';
  const last3 = Number(s.slice(-3));
  let rest = s.slice(0, -3);
  const groups: string[] = [];
  if (last3) groups.push(belowThousand(last3));
  // Then pairs of digits: thousand, lakh, crore; anything above a crore repeats "Crore".
  const names = ['Thousand', 'Lakh'];
  let i = 0;
  while (rest.length && i < names.length) {
    const n = Number(rest.slice(-2));
    rest = rest.slice(0, -2);
    if (n) groups.unshift(`${belowThousand(n)} ${names[i]}`);
    i++;
  }
  if (rest.length) groups.unshift(`${indianWords(rest)} Crore`);
  return groups.join(' ');
}

/**
 * "12500.40" → "Rupees Twelve Thousand Five Hundred and Forty Paise Only". Works on the decimal
 * string the database stored, so no float ever touches a bill. Anything that is not a plain
 * non-negative amount with at most two decimals returns ''.
 */
export function amountInWords(value: string): string {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return '';
  const rupees = m[1]!;
  const paise = Number((m[2] ?? '').padEnd(2, '0'));
  const rupeeWords = /^0+$/.test(rupees) ? '' : `Rupees ${indianWords(rupees)}`;
  const paiseWords = paise ? `${belowThousand(paise)} Paise` : '';
  if (!rupeeWords && !paiseWords) return 'Rupees Zero Only';
  return `${[rupeeWords, paiseWords].filter(Boolean).join(' and ')} Only`;
}
