// Which buttons a quotation offers. The database (mark_quotation / convert_quotation_to_invoice /
// save_quotation) enforces the same rules and is the authority; this only decides what to show, so
// nobody is offered a button that is certain to be refused.
//
//   stored status  = what is in the table ('open' | 'accepted' | 'expired' | 'converted')
//   effective      = what v_quotations.effective_status says ('expired' once valid_until has passed)

export type QuoteStatus = 'open' | 'accepted' | 'expired' | 'converted';

export const isQuoteStatus = (v: unknown): v is QuoteStatus =>
  v === 'open' || v === 'accepted' || v === 'expired' || v === 'converted';

export interface QuoteActions {
  /** Open quotes only (also one whose date has passed: extending the date is how a quote is renewed). */
  edit: boolean;
  /** open -> accepted; refused past validity. */
  accept: boolean;
  /** accepted -> open (allowed whatever the date; a quote past its date then shows as open-but-expired and can be extended). */
  reopen: boolean;
  /** open | accepted -> expired. */
  expire: boolean;
  /** open | accepted, and not past validity. */
  convert: boolean;
}

export function quoteActions(stored: QuoteStatus, effective: QuoteStatus): QuoteActions {
  const live = (stored === 'open' || stored === 'accepted') && effective !== 'expired';
  return {
    edit: stored === 'open',
    accept: stored === 'open' && live,
    reopen: stored === 'accepted',
    expire: stored === 'open' || stored === 'accepted',
    convert: live,
  };
}

/** ISO date plus whole days, in calendar terms (no time zone involved). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** Open or accepted, not yet past its date, and ending within `days` days of today. */
export function expiresWithin(effective: QuoteStatus, validUntil: string, today: string, days = 2): boolean {
  if (effective !== 'open' && effective !== 'accepted') return false;
  return validUntil >= today && validUntil <= addDaysIso(today, days);
}
