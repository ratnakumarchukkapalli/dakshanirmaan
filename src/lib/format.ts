// Display helpers. Dates travel as ISO strings (YYYY-MM-DD); nothing here parses them
// through Date, so the viewer's time zone can never shift a business date.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function parts(iso: string): { y: number; m: number; d: number } {
  const match = ISO_DATE.exec(iso);
  if (!match) throw new Error(`Not an ISO date: ${iso}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
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
