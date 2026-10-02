import { Document, Page, StyleSheet, Text, View, type DocumentProps } from '@react-pdf/renderer';
import type { ReactElement } from 'react';
import { BODY_FONT } from '@/lib/invoice-pdf/fonts';

// One small, generic tabular report for the year archive's PDFs (trial balance, profit and loss, balance
// sheet, ageing, stock valuation, GST summary). A pure function of the rows it is given: no figure is
// computed here. Same Noto Sans as the invoices; black on white (a print palette, no theme); the title
// block and column heads repeat on every page; numbers are right-aligned and, in Noto Sans, tabular.
// English only: Telugu names print as "?" in the PDFs (this face has no Telugu); the Excel and JSON files carry them.

const INK = '#111111';
const MUTED = '#555555';
const RULE = '#999999';
const HEAD = '#eeeeee';

export interface ReportColumn {
  header: string;
  /** Relative width. */
  width: number;
  align?: 'left' | 'right';
}

export interface ReportRow {
  cells: string[];
  bold?: boolean;
  /** A heavier line above the row (a total). */
  rule?: boolean;
  /** A shaded section heading spanning the row. */
  section?: boolean;
}

export interface ReportSpec {
  orgName: string;
  title: string;
  subtitle?: string;
  /** "Financial year 2026-27 · figures as at 31-03-2027" */
  period: string;
  /** "Data as of 02-10-2026 14:05 IST" */
  asOf: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Plain sentences under the table (a check result, how a figure is built). */
  notes?: string[];
  landscape?: boolean;
}

const s = StyleSheet.create({
  page: { fontFamily: BODY_FONT, fontSize: 8.5, color: INK, paddingTop: 30, paddingBottom: 46, paddingHorizontal: 30, lineHeight: 1.3 },
  org: { fontSize: 13, fontWeight: 700 },
  title: { fontSize: 11, fontWeight: 700, marginTop: 2 },
  muted: { color: MUTED, fontSize: 8 },
  head: { flexDirection: 'row', backgroundColor: HEAD, borderBottomWidth: 0.7, borderColor: RULE, marginTop: 8 },
  row: { flexDirection: 'row', borderBottomWidth: 0.4, borderColor: '#cccccc' },
  cell: { paddingVertical: 2.5, paddingHorizontal: 3 },
  bold: { fontWeight: 700 },
  right: { textAlign: 'right' },
  rule: { borderTopWidth: 0.9, borderTopColor: INK },
  section: { backgroundColor: '#f6f6f6', fontWeight: 700 },
  note: { marginTop: 8, fontSize: 8, color: MUTED },
  footer: { position: 'absolute', bottom: 20, left: 30, right: 30, flexDirection: 'row', justifyContent: 'space-between', fontSize: 7.5, color: MUTED },
});

/** Noto Sans (Latin) has no Telugu glyphs and would print them on top of each other: anything outside Latin, punctuation and the rupee sign becomes "?". */
export const pdfText = (value: string): string => value.replace(/[^\u0000-\u024F\u2000-\u206F\u20B9]+/g, '?');

export function reportDocument(input: ReportSpec): ReactElement<DocumentProps> {
  const spec: ReportSpec = {
    ...input,
    orgName: pdfText(input.orgName), title: pdfText(input.title), ...(input.subtitle ? { subtitle: pdfText(input.subtitle) } : {}),
    columns: input.columns.map((c) => ({ ...c, header: pdfText(c.header) })),
    rows: input.rows.map((r) => ({ ...r, cells: r.cells.map(pdfText) })),
    ...(input.notes ? { notes: input.notes.map(pdfText) } : {}),
  };
  const total = spec.columns.reduce((n, c) => n + c.width, 0);
  const width = (c: ReportColumn) => `${(c.width / total) * 100}%`;
  return (
    <Document title={`${spec.orgName} - ${spec.title}`} author={spec.orgName} creator="Daksha Nirmaan" producer="Daksha Nirmaan">
      <Page size="A4" orientation={spec.landscape ? 'landscape' : 'portrait'} style={s.page}>
        <View fixed>
          <Text style={s.org}>{spec.orgName}</Text>
          <Text style={s.title}>{spec.title}</Text>
          {spec.subtitle ? <Text style={s.muted}>{spec.subtitle}</Text> : null}
          <Text style={s.muted}>{spec.period}   ·   {spec.asOf}</Text>
          <View style={s.head}>
            {spec.columns.map((c, i) => (
              <Text key={i} style={[s.cell, s.bold, c.align === 'right' ? s.right : {}, { width: width(c) }]}>{c.header}</Text>
            ))}
          </View>
        </View>
        {spec.rows.map((r, i) => (
          <View key={i} wrap={false} style={[s.row, r.rule ? s.rule : {}, r.section ? s.section : {}]}>
            {r.section ? (
              <Text style={[s.cell, s.bold, { width: '100%' }]}>{r.cells[0] ?? ''}</Text>
            ) : (
              spec.columns.map((c, j) => (
                <Text key={j} style={[s.cell, r.bold ? s.bold : {}, c.align === 'right' ? s.right : {}, { width: width(c) }]}>{r.cells[j] ?? ''}</Text>
              ))
            )}
          </View>
        ))}
        {spec.rows.length === 0 ? <Text style={s.note}>Nothing to report for this year.</Text> : null}
        {(spec.notes ?? []).map((n, i) => <Text key={i} style={s.note}>{n}</Text>)}
        <View style={s.footer} fixed>
          <Text>{spec.orgName} - {spec.title}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** "-1234567.8" -> "-12,34,567.80": a decimal text grouped the Indian way, without going through a float. */
export function groupIndian(text: string | null | undefined, places = 2): string {
  if (text === null || text === undefined || text === '') return '';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return text;
  const [, sign = '', whole = '0', frac = ''] = m;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  if (frac.length > places && /[1-9]/.test(frac.slice(places))) throw new Error(`report: ${text} has more than ${places} decimal places`);
  const fraction = places > 0 ? `.${frac.padEnd(places, '0').slice(0, places)}` : '';
  return `${sign}${grouped}${fraction}`;
}
