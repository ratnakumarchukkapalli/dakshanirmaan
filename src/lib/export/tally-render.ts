import type { TallyLedger, TallyVoucher } from './tally-model';
import { encodeUtf16, tallyAmount, xmlAttr, xmlText } from './tally-xml';

// The two Tally files as text, in the envelope shape of docs/research/tally-xml-format.md section 1.
// Masters and vouchers are separate files (different REPORTNAME; masters must exist first). Rendering is
// a generator of text chunks, so a file never has to exist in memory as one string.

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-16"?>\n';

function* envelope(report: string, company: string | null, extraStatic: string, body: Iterable<string>): Generator<string> {
  yield XML_DECLARATION;
  yield '<ENVELOPE>\n<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>\n<BODY><IMPORTDATA><REQUESTDESC>\n';
  yield `<REPORTNAME>${report}</REPORTNAME>\n`;
  const statics = `${company ? `<SVCURRENTCOMPANY>${xmlText(company)}</SVCURRENTCOMPANY>` : ''}${extraStatic}`;
  if (statics) yield `<STATICVARIABLES>${statics}</STATICVARIABLES>\n`;
  yield '</REQUESTDESC>\n<REQUESTDATA>\n';
  yield* body;
  yield '</REQUESTDATA>\n</IMPORTDATA></BODY>\n</ENVELOPE>\n';
}

export function* renderMasters(ledgers: readonly TallyLedger[], company: string | null): Generator<string> {
  function* body(): Generator<string> {
    for (const l of ledgers) {
      if (l.skipMaster) continue;
      yield `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xmlAttr(l.name)}" ACTION="Create"><NAME>${xmlText(l.name)}</NAME><PARENT>${xmlText(l.parent)}</PARENT><ISBILLWISEON>No</ISBILLWISEON></LEDGER></TALLYMESSAGE>\n`;
    }
  }
  yield* envelope('All Masters', company, '<IMPORTDUPS>@@DUPIGNORECOMBINE</IMPORTDUPS>', body());
}

export function renderVoucher(v: TallyVoucher): string {
  const lines = v.lines.map((l) => {
    const isParty = v.partyLedger !== null && l.ledger === v.partyLedger;
    return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlText(l.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${l.side === 'debit' ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>${isParty ? '<ISPARTYLEDGER>Yes</ISPARTYLEDGER>' : ''}<AMOUNT>${tallyAmount(l.side, l.amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>\n`;
  });
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${xmlAttr(v.remoteId)}" VCHTYPE="${xmlAttr(v.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">\n`
    + `<DATE>${v.date}</DATE><EFFECTIVEDATE>${v.date}</EFFECTIVEDATE><VOUCHERTYPENAME>${xmlText(v.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xmlText(v.number)}</VOUCHERNUMBER>\n`
    + `${v.partyLedger ? `<PARTYLEDGERNAME>${xmlText(v.partyLedger)}</PARTYLEDGERNAME>` : ''}<ISINVOICE>No</ISINVOICE><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>`
    + `${v.narration ? `<NARRATION>${xmlText(v.narration)}</NARRATION>` : ''}\n${lines.join('')}</VOUCHER></TALLYMESSAGE>\n`;
}

export function* renderVouchers(vouchers: readonly TallyVoucher[], company: string | null): Generator<string> {
  function* body(): Generator<string> {
    for (const v of vouchers) yield renderVoucher(v);
  }
  yield* envelope('Vouchers', company, '', body());
}

/** Text chunks -> UTF-16LE byte chunks of about 64 KB; the byte-order mark leads the first one. */
export function* utf16Chunks(text: Iterable<string>, chunkChars = 32_768): Generator<Buffer> {
  let pending = '';
  let first = true;
  const flush = (): Buffer => {
    const out = encodeUtf16(pending, first);
    first = false;
    pending = '';
    return out;
  };
  for (const piece of text) {
    pending += piece;
    if (pending.length >= chunkChars) yield flush();
  }
  if (pending.length > 0 || first) yield flush();
}
