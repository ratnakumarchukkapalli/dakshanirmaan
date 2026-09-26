// Financial-year helpers. The FY runs April to March (a hard rule: the start month is locked).
// Dates are ISO strings and are never parsed through Date, so a time zone cannot shift them.

const FY_START_MONTH = 4;

/** The calendar year the FY containing `iso` starts in: 2026-09-19 -> 2026, 2027-02-01 -> 2026. */
export function fyStartYear(iso: string): number {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso);
  if (!m) throw new Error(`Not an ISO date: ${iso}`);
  const year = Number(m[1]);
  return Number(m[2]) >= FY_START_MONTH ? year : year - 1;
}

/** 2026 -> { from: '2026-04-01', to: '2027-03-31' }. */
export function fyRange(startYear: number): { from: string; to: string } {
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` };
}

/** 2026 -> '2026-27'. */
export function fyName(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** `?fy=` value -> a start year, 'all', or null when it is not something we offer. */
export function parseFyParam(raw: string | undefined | null, currentStartYear: number): number | 'all' {
  if (raw === 'all') return 'all';
  if (raw && /^\d{4}$/.test(raw)) {
    const y = Number(raw);
    if (y >= 2000 && y <= currentStartYear) return y;
  }
  return currentStartYear;
}
