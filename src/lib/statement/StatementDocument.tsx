import { Document, Page, StyleSheet, Text, View, type DocumentProps } from '@react-pdf/renderer';
import { createElement, type ReactElement } from 'react';
import { BODY_FONT, RUPEE_FONT } from '@/lib/invoice-pdf/fonts';
import { fyName, fyStartYear } from '@/lib/fy';
import { formatDate, inr2 } from '@/lib/format';
import type { PartyLedger } from '@/lib/party-ledger';
import type { StatementOrg } from './xlsx';

// The party statement, printed. English only (like the invoice). A pure function of the stored
// ledger: no figure is computed here. Colours are the print palette shared with the invoice PDF
// (black on white); there is no theme in a PDF.

const INK = '#111111';
const MUTED = '#555555';
const RULE = '#999999';
const HEAD = '#eeeeee';

const s = StyleSheet.create({
  page: { fontFamily: BODY_FONT, fontSize: 8.5, color: INK, paddingTop: 28, paddingBottom: 48, paddingHorizontal: 28, lineHeight: 1.35 },
  h1: { fontSize: 14, fontWeight: 700, marginBottom: 3 },
  title: { fontSize: 11, fontWeight: 700, marginTop: 6 },
  muted: { color: MUTED },
  bold: { fontWeight: 700 },
  th: { flexDirection: 'row', backgroundColor: HEAD, fontWeight: 700, borderBottomWidth: 0.7, borderColor: RULE, marginTop: 10 },
  tr: { flexDirection: 'row', borderBottomWidth: 0.5, borderColor: RULE },
  cell: { paddingVertical: 3, paddingHorizontal: 3 },
  r: { textAlign: 'right' },
  foot: { position: 'absolute', bottom: 20, left: 28, right: 28, flexDirection: 'row', justifyContent: 'space-between', color: MUTED, fontSize: 7.5 },
});

export interface StatementLabels {
  title: string; party: string; gstin: string; period: string; allTime: string; date: string; document: string; account: string;
  details: string; debit: string; credit: string; balance: string; broughtForward: string; closing: string; receivable: string;
  payable: string; reversal: string; page: string;
}

function Money({ value, bold }: { value: string; bold?: boolean }) {
  const text = inr2(value);
  const at = text.indexOf('₹');
  return (
    <Text style={bold ? s.bold : undefined}>
      {text.slice(0, at)}
      <Text style={{ fontFamily: RUPEE_FONT }}>₹</Text>
      {text.slice(at + 1)}
    </Text>
  );
}

export function StatementDocument({ ledger, org, labels }: { ledger: PartyLedger; org: StatementOrg; labels: StatementLabels }) {
  if (ledger.truncated) throw new Error('statement: the ledger was truncated; refusing to print a partial statement');
  const both = ledger.party.type === 'both';
  const acct = (k: 'ar' | 'ap') => (k === 'ar' ? labels.receivable : labels.payable);
  // Column widths (%): date, document, [account], details, debit, credit, balance.
  const w = both ? ['11%', '17%', '11%', '25%', '12%', '12%', '12%'] : ['11%', '17%', '0%', '33%', '13%', '13%', '13%'];
  const cells = (parts: (string | null)[], money: { d?: string; c?: string; b?: string }, bold = false, keyPrefix = '') => (
    <View style={s.tr} wrap={false} key={keyPrefix}>
      <Text style={[s.cell, { width: w[0] }]}>{parts[0]}</Text>
      <Text style={[s.cell, { width: w[1] }, bold ? s.bold : {}]}>{parts[1]}</Text>
      {both ? <Text style={[s.cell, { width: w[2] }]}>{parts[2]}</Text> : null}
      <Text style={[s.cell, { width: w[3] }]}>{parts[3]}</Text>
      <View style={[s.cell, s.r, { width: w[4] }]}>{money.d ? <Money value={money.d} /> : <Text />}</View>
      <View style={[s.cell, s.r, { width: w[5] }]}>{money.c ? <Money value={money.c} /> : <Text />}</View>
      <View style={[s.cell, s.r, { width: w[6] }]}>{money.b ? <Money value={money.b} bold /> : <Text />}</View>
    </View>
  );
  const isZero = (v: string) => /^0+(\.0+)?$/.test(v);
  const period = ledger.period ? `${fyName(fyStartYear(ledger.period.from))} (${formatDate(ledger.period.from)} to ${formatDate(ledger.period.to)})` : labels.allTime;

  return (
    <Document title={`${labels.title} - ${ledger.party.name}`}>
      <Page size="A4" style={s.page}>
        <Text style={s.h1}>{org.legalName}</Text>
        {org.gstin ? <Text style={s.muted}>GSTIN: {org.gstin}</Text> : null}
        <Text style={s.title}>{labels.title}</Text>
        <Text>{labels.party}: <Text style={s.bold}>{ledger.party.name}</Text>{ledger.party.gstin ? `  ·  ${labels.gstin}: ${ledger.party.gstin}` : ''}</Text>
        <Text style={s.muted}>{labels.period}: {period}</Text>

        <View style={s.th} fixed>
          <Text style={[s.cell, { width: w[0] }]}>{labels.date}</Text>
          <Text style={[s.cell, { width: w[1] }]}>{labels.document}</Text>
          {both ? <Text style={[s.cell, { width: w[2] }]}>{labels.account}</Text> : null}
          <Text style={[s.cell, { width: w[3] }]}>{labels.details}</Text>
          <Text style={[s.cell, s.r, { width: w[4] }]}>{labels.debit}</Text>
          <Text style={[s.cell, s.r, { width: w[5] }]}>{labels.credit}</Text>
          <Text style={[s.cell, s.r, { width: w[6] }]}>{labels.balance}</Text>
        </View>

        {ledger.period && (['ar', 'ap'] as const).map((k) => {
          const bf = ledger.broughtForward[k];
          return bf === undefined ? null : cells([formatDate(ledger.period!.from), labels.broughtForward, acct(k), null], { b: bf }, false, `bf-${k}`);
        })}
        {ledger.rows.map((r) =>
          cells(
            [formatDate(r.date), r.docNo ?? '', acct(r.accountKey), [r.narration, r.isReversal ? labels.reversal : null].filter(Boolean).join(' · ')],
            { d: isZero(r.debit) ? undefined : r.debit, c: isZero(r.credit) ? undefined : r.credit, b: r.balance }, false, r.key),
        )}
        {(['ar', 'ap'] as const).map((k) => {
          const c = ledger.closing[k];
          return c === undefined ? null : cells([null, `${labels.closing}${both ? ` · ${acct(k)}` : ''}`, acct(k), null], { b: c }, true, `close-${k}`);
        })}

        <View style={s.foot} fixed>
          <Text>{org.legalName}</Text>
          <Text render={({ pageNumber, totalPages }) => `${labels.page} ${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** The element for renderToBuffer (which wants a Document element, not a component). */
export const statementDocument = (ledger: PartyLedger, org: StatementOrg, labels: StatementLabels) =>
  createElement(StatementDocument, { ledger, org, labels }) as unknown as ReactElement<DocumentProps>;
