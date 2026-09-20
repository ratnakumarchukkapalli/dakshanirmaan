import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { ReactNode } from 'react';
import { amountInWords, formatDate, inr2, inrRate } from '@/lib/format';
import { stateName } from '@/lib/gst';
import { trimZeros } from '@/lib/units';
import { BODY_FONT, RUPEE_FONT } from './fonts';
import type { InvoicePdfData, PdfAddress } from './data';

// The GST tax invoice. English only (the GST portal's language). A pure function of stored data:
// no figure is computed here. Colours are the print palette (black on white); there is no theme.

const INK = '#111111';
const MUTED = '#555555';
const RULE = '#999999';
const HEAD = '#eeeeee';

const s = StyleSheet.create({
  page: { fontFamily: BODY_FONT, fontSize: 8.5, color: INK, paddingTop: 28, paddingBottom: 64, paddingHorizontal: 28, lineHeight: 1.35 },
  row: { flexDirection: 'row' },
  between: { flexDirection: 'row', justifyContent: 'space-between' },
  h1: { fontSize: 14, fontWeight: 700, marginBottom: 3 },
  title: { fontSize: 12, fontWeight: 700, textAlign: 'right' },
  muted: { color: MUTED },
  bold: { fontWeight: 700 },
  box: { borderWidth: 0.7, borderColor: RULE, padding: 6 },
  boxLabel: { fontSize: 7, color: MUTED, marginBottom: 2, textTransform: 'uppercase' },
  gap: { marginTop: 8 },
  th: { backgroundColor: HEAD, fontWeight: 700, borderBottomWidth: 0.7, borderColor: RULE },
  tr: { flexDirection: 'row', borderBottomWidth: 0.5, borderColor: RULE },
  cell: { paddingVertical: 3, paddingHorizontal: 3 },
  r: { textAlign: 'right' },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 1.5 },
  grand: { fontSize: 11, fontWeight: 700, borderTopWidth: 0.7, borderColor: INK, marginTop: 3, paddingTop: 3 },
  watermark: { position: 'absolute', top: 300, left: 40, fontSize: 90, fontWeight: 700, color: '#d33', opacity: 0.16, transform: 'rotate(-30deg)' },
  footer: { position: 'absolute', bottom: 22, left: 28, right: 28, flexDirection: 'row', justifyContent: 'flex-end' },
});

// Column widths (%), in order: #, item, HSN, qty, rate, [disc], taxable, GST %, tax, amount.
const widths = (disc: boolean) => (disc
  ? ['4%', '21%', '8%', '11%', '9%', '6%', '12%', '6%', '10%', '13%']
  : ['4%', '27%', '8%', '11%', '9%', '0%', '12%', '6%', '10%', '13%']);

/** "₹1,234.50" with the sign set in the Rupee-carrying face. Negative amounts read "-₹0.40". */
function Money({ value, bold, rate }: { value: string; bold?: boolean; rate?: boolean }) {
  const text = rate ? inrRate(value) : inr2(value);
  const at = text.indexOf('₹');
  return (
    <Text style={bold ? s.bold : undefined}>
      {text.slice(0, at)}
      <Text style={{ fontFamily: RUPEE_FONT }}>₹</Text>
      {text.slice(at + 1)}
    </Text>
  );
}

const addressLines = (a: PdfAddress | null): string[] => {
  if (!a) return [];
  return [a.line1, a.line2, [a.city, a.pincode].filter(Boolean).join(' ')].filter((v): v is string => !!v && v.trim() !== '');
};

function Party({ label, name, gstin, address, state }: { label: string; name: string; gstin?: string | null; address: PdfAddress | null; state?: string }) {
  return (
    <View style={[s.box, { flex: 1 }]}>
      <Text style={s.boxLabel}>{label}</Text>
      <Text style={s.bold}>{name}</Text>
      {addressLines(address).map((l, i) => <Text key={i}>{l}</Text>)}
      {state ? <Text>{stateName(state)} ({state})</Text> : null}
      {gstin ? <Text>GSTIN: {gstin}</Text> : null}
    </View>
  );
}

export function InvoiceDocument({ data, qr }: { data: InvoicePdfData; qr: string | null }) {
  const hasDisc = data.lines.some((l) => /[1-9]/.test(l.discountPct));
  const w = widths(hasDisc);
  const t = data.transport;
  const hasTransport = !!(t.vehicleNo || t.transporterName || t.ewbNo || t.mode);
  const org = data.org;
  const billingState = data.billing?.state_code ?? undefined;
  const shipLabel = data.shipping ? 'Ship to' : '';
  const cell = (i: number, node: ReactNode, right = false) => (
    w[i] === '0%' ? null : <View style={[s.cell, { width: w[i] }]}>{typeof node === 'string' ? <Text style={right ? s.r : undefined}>{node}</Text> : node}</View>
  );

  return (
    <Document title={`Tax Invoice ${data.number}`} author={org.legalName} creator="Daksha Nirmaan" producer="Daksha Nirmaan">
      <Page size="A4" style={s.page}>
        {data.cancelled && <Text fixed style={s.watermark}>CANCELLED</Text>}

        <View style={s.between}>
          <View style={{ maxWidth: '62%' }}>
            <Text style={s.h1}>{org.legalName}</Text>
            {org.tradeName && org.tradeName !== org.legalName ? <Text style={s.muted}>({org.tradeName})</Text> : null}
            {addressLines(org.address).map((l, i) => <Text key={i}>{l}</Text>)}
            <Text>{stateName(org.stateCode)} ({org.stateCode}){org.gstin ? `  ·  GSTIN: ${org.gstin}` : ''}</Text>
          </View>
          <View>
            <Text style={s.title}>TAX INVOICE</Text>
            {data.cancelled ? <Text style={[s.title, { color: '#b00' }]}>CANCELLED</Text> : null}
            <Text style={s.r}>Invoice No: <Text style={s.bold}>{data.number}</Text></Text>
            <Text style={s.r}>Date: {formatDate(data.date)}</Text>
            <Text style={s.r}>Place of supply: {stateName(data.placeOfSupply)} ({data.placeOfSupply})</Text>
          </View>
        </View>

        <View style={[s.row, s.gap, { gap: 8 }]}>
          <Party label="Bill to" name={data.party.name} gstin={data.party.gstin} address={data.billing} state={billingState} />
          {shipLabel ? <Party label={shipLabel} name={data.party.name} address={data.shipping} state={data.shipping?.state_code} /> : null}
        </View>

        {hasTransport && (
          <View style={[s.box, s.gap]}>
            <Text style={s.boxLabel}>Transport</Text>
            <View style={[s.row, { flexWrap: 'wrap', gap: 14 }]}>
              {t.vehicleNo ? <Text>Vehicle: {t.vehicleNo}</Text> : null}
              {t.mode ? <Text>Mode: {t.mode}</Text> : null}
              {t.distanceKm !== null ? <Text>Distance: {t.distanceKm} km</Text> : null}
              {t.transporterName ? <Text>Transporter: {t.transporterName}</Text> : null}
              {t.transporterGstin ? <Text>Transporter GSTIN: {t.transporterGstin}</Text> : null}
              {t.ewbNo ? <Text>E-way bill: {t.ewbNo}{t.ewbDate ? ` dt ${formatDate(t.ewbDate)}` : ''}{t.ewbValidUntil ? `, valid until ${formatDate(t.ewbValidUntil.slice(0, 10))}` : ''}</Text> : null}
            </View>
          </View>
        )}

        <View style={[s.gap, { borderTopWidth: 0.7, borderColor: RULE }]}>
          <View style={[s.tr, s.th]} fixed>
            {cell(0, '#')}{cell(1, 'Description')}{cell(2, 'HSN')}{cell(3, <Text style={s.r}>Qty</Text>)}{cell(4, <Text style={s.r}>Rate</Text>)}
            {cell(5, <Text style={s.r}>Disc%</Text>)}{cell(6, <Text style={s.r}>Taxable</Text>)}{cell(7, <Text style={s.r}>GST%</Text>)}
            {cell(8, <Text style={s.r}>Tax</Text>)}{cell(9, <Text style={s.r}>Amount</Text>)}
          </View>
          {data.lines.map((l) => (
            <View key={l.no} style={s.tr} wrap={false}>
              {cell(0, String(l.no))}
              {cell(1, l.name)}
              {cell(2, l.hsn)}
              {cell(3, <Text style={s.r}>{trimZeros(l.qty)} {l.uom}</Text>)}
              {cell(4, <View><Text style={s.r}><Money value={l.rate} rate /></Text></View>)}
              {cell(5, <Text style={s.r}>{/[1-9]/.test(l.discountPct) ? `${trimZeros(l.discountPct)}%` : ''}</Text>)}
              {cell(6, <Text style={s.r}><Money value={l.taxable} /></Text>)}
              {cell(7, <Text style={s.r}>{trimZeros(l.gstRate)}%</Text>)}
              {cell(8, <Text style={s.r}><Money value={l.tax} /></Text>)}
              {cell(9, <Text style={s.r}><Money value={l.amount} /></Text>)}
            </View>
          ))}
        </View>

        <View style={[s.row, s.gap, { gap: 12 }]} wrap={false}>
          <View style={{ flex: 1.2 }}>
            <Text style={s.boxLabel}>Amount in words</Text>
            <Text style={s.bold}>{amountInWords(data.totals.grand)}</Text>
            {data.cancelled ? null : data.open === '0.00' ? (
              <Text style={[s.bold, { marginTop: 8 }]}>PAID</Text>
            ) : qr ? (
              <View style={[s.row, { marginTop: 8, gap: 8, alignItems: 'center' }]}>
                <Image src={qr} style={{ width: 78, height: 78 }} />
                <View>
                  <Text style={s.bold}>Pay by UPI</Text>
                  <Text>Scan to pay <Money value={data.open} bold /></Text>
                  {org.upiVpa ? <Text style={s.muted}>{org.upiVpa}</Text> : null}
                </View>
              </View>
            ) : null}
            {org.bankDetails ? (
              <View style={{ marginTop: 8 }}>
                <Text style={s.boxLabel}>Bank details</Text>
                <Text>{org.bankDetails}</Text>
              </View>
            ) : null}
          </View>
          <View style={{ flex: 1 }}>
            <View style={s.totalsRow}><Text>Taxable value</Text><Money value={data.totals.taxable} /></View>
            {data.intra ? (
              <>
                <View style={s.totalsRow}><Text>CGST</Text><Money value={data.totals.cgst} /></View>
                <View style={s.totalsRow}><Text>SGST</Text><Money value={data.totals.sgst} /></View>
              </>
            ) : (
              <View style={s.totalsRow}><Text>IGST</Text><Money value={data.totals.igst} /></View>
            )}
            <View style={s.totalsRow}><Text>Round off</Text><Money value={data.totals.roundOff} /></View>
            <View style={[s.totalsRow, s.grand]}><Text>Total</Text><Money value={data.totals.grand} bold /></View>
          </View>
        </View>

        {org.footer ? <Text style={[s.gap, s.muted]}>{org.footer}</Text> : null}

        <Text fixed style={[s.muted, { position: 'absolute', bottom: 22, left: 28 }]} render={({ pageNumber, totalPages }) => `${data.number} · Page ${pageNumber} of ${totalPages}`} />
        <View style={s.footer} fixed>
          <View style={{ alignItems: 'flex-end' }}>
            <Text>For {org.legalName}</Text>
            <Text style={[s.muted, { marginTop: 18 }]}>Authorised signatory</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}
