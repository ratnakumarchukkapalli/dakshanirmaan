// The three ways out of the system (change 25) and which of them are built. Plain constants, safe for
// screens and routes alike.

export type ExportKind = 'books' | 'tally' | 'archive';
export const EXPORT_KINDS: readonly ExportKind[] = ['books', 'tally', 'archive'];

/**
 * Flip a kind to `true` when its route exists. The Export screen shows a kind that is not ready as a
 * disabled "coming next" button instead of a link to a route that would answer 404.
 */
export const EXPORT_READY: Record<ExportKind, boolean> = { books: true, tally: true, archive: true };

export const EXPORT_PATH: Record<ExportKind, string> = {
  books: '/api/backup/books.xlsx',
  tally: '/api/reports/tally.xml',
  archive: '/api/backup/archive.zip',
};

/** The Tally file comes in two parts, imported in this order. */
export const TALLY_PARTS = ['masters', 'vouchers'] as const;
export type TallyPart = (typeof TALLY_PARTS)[number];

export const exportHref = (kind: ExportKind, fyStartYear: number, part?: TallyPart): string =>
  `${EXPORT_PATH[kind]}?fy=${fyStartYear}${part ? `&part=${part}` : ''}`;
