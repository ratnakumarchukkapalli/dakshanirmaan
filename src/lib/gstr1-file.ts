// The GSTR-1 file the GST portal takes (offline-tool JSON), and the rules for when it may be handed out.
// Every figure comes from `gstr1_data` (the database); this only wraps the envelope and leaves out
// empty sections. Shape and sources: docs/research/gstr1-schema.md (verify by uploading one real
// file before the first filing).

export interface Gstr1Summary { count: number; txval: number | string; iamt: number | string; camt: number | string; samt: number | string }

export interface Gstr1Data {
  period: string;
  fp: string;
  gstin: string | null;
  b2b: unknown[];
  b2cl: unknown[];
  b2cs: unknown[];
  cdnr: unknown[];
  nil: { inv: unknown[] };
  hsn: { hsn_b2b: unknown[]; hsn_b2c: unknown[] };
  doc_issue: { doc_det: unknown[] };
  totals: { invoices: number; notes: number; taxable: number | string; igst: number | string; cgst: number | string; sgst: number | string };
  summary: Record<'b2b' | 'b2cl' | 'b2cs' | 'cdnr' | 'nil' | 'hsn', Gstr1Summary>;
  warnings: { key: string; count: number }[];
}

/** The offline tool's schema version string at the time of research; check on first upload. */
export const GSTR1_VERSION = 'GST3.2.2';

/** Warnings that make the file wrong or unfileable: the download is withheld until they are fixed. */
export const BLOCKING_WARNINGS = ['no_hsn', 'unmapped_uom', 'export_not_supported', 'cdnur_not_supported', 'org_gstin_missing'] as const;

export const blockingWarnings = (d: Gstr1Data): string[] =>
  d.warnings.filter((w) => (BLOCKING_WARNINGS as readonly string[]).includes(w.key)).map((w) => w.key);

/** `2026-09` and nothing else. */
export const isPeriod = (v: string | null | undefined): v is string => !!v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

export const gstr1Filename = (period: string, ext: 'json' | 'xlsx' = 'json') => `GSTR1-${period}.${ext}`;

/**
 * The portal file. Empty sections are left out (the portal treats an absent section as nothing to
 * report). `gt`/`cur_gt` are the taxpayer's declared turnover, which the books alone cannot supply, so they
 * are written as 0 and entered on the portal.
 */
export function buildGstr1File(d: Gstr1Data): Record<string, unknown> {
  const file: Record<string, unknown> = { gstin: d.gstin, fp: d.fp, gt: 0, cur_gt: 0, version: GSTR1_VERSION, hash: 'hash' };
  if (d.b2b.length) file.b2b = d.b2b;
  if (d.b2cl.length) file.b2cl = d.b2cl;
  if (d.b2cs.length) file.b2cs = d.b2cs;
  if (d.cdnr.length) file.cdnr = d.cdnr;
  if (d.nil.inv.length) file.nil = d.nil;
  const hsn: Record<string, unknown> = {};
  if (d.hsn.hsn_b2b.length) hsn.hsn_b2b = d.hsn.hsn_b2b;
  if (d.hsn.hsn_b2c.length) hsn.hsn_b2c = d.hsn.hsn_b2c;
  if (Object.keys(hsn).length) file.hsn = hsn;
  if (d.doc_issue.doc_det.length) file.doc_issue = d.doc_issue;
  return file;
}

/** The month before today's date: the return that is usually being prepared. `2026-09-26` -> `2026-08`, `2026-01-05` -> `2025-12`. */
export function previousPeriod(todayIso: string): string {
  const [y, m] = todayIso.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** `?period=` from the URL, or the previous month when it is missing or not a real month. */
export const periodOrDefault = (raw: string | null | undefined, todayIso: string): string => (isPeriod(raw) ? raw : previousPeriod(todayIso));
