import { formatDate } from '@/lib/format';
import { blockingWarnings, type Gstr1Data } from '@/lib/gstr1-file';
import type { GstBundle } from './books-tables';
import { generatedAtText } from './period';
import type { ExportContext } from './types';

// README.txt of the year archive: plain English, for someone with no app and no accountant on the phone.

export interface GstrPlan {
  include: { month: string; path: string; data: Gstr1Data }[];
  /** One sentence per month or reason left out. */
  notes: string[];
}

/** Which months get a portal-ready GSTR-1 file: those with sales or notes, and nothing the portal would reject. */
export function planGstr1(gst: GstBundle): GstrPlan {
  if (!gst.ok) return { include: [], notes: [`The GST data could not be read when this archive was made, so there are no GSTR-1 files. ${gst.reason}`] };
  const include: GstrPlan['include'] = [];
  const notes: string[] = [];
  for (const m of gst.months) {
    const t = m.gstr1.totals;
    if (Number(t?.invoices ?? 0) + Number(t?.notes ?? 0) === 0) continue;
    const blocked = blockingWarnings(m.gstr1);
    if (blocked.length > 0) {
      notes.push(`${m.month}: no GSTR-1 file, because the portal would reject it (${blocked.join(', ')}). The month's figures are in the GST sheets of books.xlsx.`);
      continue;
    }
    include.push({ month: m.month, path: `gst/gstr1-${m.month}.json`, data: m.gstr1 });
  }
  return { include, notes };
}

export interface ReadmeInput {
  ctx: ExportContext;
  dataFiles: { path: string; description: string; rows: number | null }[];
  reportPaths: string[];
  omittedReports: string[];
  gstr1: GstrPlan;
  tally: { ledgers: number; vouchers: number; hasOpeningVoucher: boolean };
  trialBalanceBalanced: boolean;
  skippedSheets: { sheet: string; reason: string }[];
}

const wrap = (text: string, width = 96, indent = ''): string[] => {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > width) {
      out.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(indent + line);
  return out;
};

const para = (text: string) => [...wrap(text), ''];
const item = (name: string, text: string) => {
  const lines = wrap(text, 70);
  return [`  ${name}`, ...lines.map((l) => `      ${l}`), ''];
};

export function readmeText(input: ReadmeInput): string {
  const { ctx } = input;
  const at = (iso: string) => generatedAtText(new Date(iso), ctx.timeZone);
  const L: string[] = [];
  const title = `${ctx.orgName} - books for financial year ${ctx.fy.label}`;
  L.push(title, '='.repeat(title.length), '');
  L.push(`Financial year : ${ctx.fy.label} (${formatDate(ctx.fy.from)} to ${formatDate(ctx.fy.to)})`);
  L.push(`Generated      : ${generatedAtText(new Date(), ctx.timeZone)}, by ${ctx.generatedBy}`);
  L.push(`Data as of     : ${at(ctx.asOf)}`);
  L.push('');
  L.push('WHAT THIS IS', '');
  L.push(...para('This archive is a complete copy of one financial year of the books, kept in formats that open without the Daksha Nirmaan app, today or years from now. It is a copy: nothing in it can change the books. The data files are read as of the "data as of" moment above and leave out anything created after it. The trial balance and GST figures are read from the database reports a moment later, and a document cancelled while the archive was being made would show in one place and not another. The last sheet of books.xlsx (Checks) counts such documents; if it reports any, make the archive again.'));
  L.push(...para('Cancelled documents and the entries that reverse them are included and marked, exactly as the books hold them. Drafts (documents that were never posted) are not included.'));

  L.push('WHAT IS IN IT', '');
  L.push(...item('README.txt', 'This page.'));
  L.push(...item('books.xlsx', 'The whole year as an Excel workbook, one sheet per topic: chart of accounts, trial balance, journal, party ledger, sales and purchase invoices with their lines, notes, payments, stock, GST, day closes and bank lines. Open it with Excel, LibreOffice or Google Sheets. The first sheet says what every other sheet is; the last sheet has the self-checks.'));
  L.push(...item('reports/*.pdf', `Printable statements: ${input.reportPaths.map((p) => p.replace('reports/', '')).join(', ')}. Ageing and stock are as at the last day of the year. Names in Telugu show as ? in these PDFs; the Excel and JSON files have them in full.`));
  L.push(...item('data/*.json', 'The same tables as plain JSON files, one file per table, for any program or a future accountant to read. Money, quantities and rates are written as decimal text (for example "1234567.89") so no digit is ever rounded; dates are ISO (2026-09-15); times are ISO 8601. data/schema.json lists every file, its row count and each column with its type.'));
  L.push(...item('tally/masters.xml and tally/vouchers.xml', 'The year in Tally\'s XML import format (see the Tally note below).'));
  if (input.gstr1.include.length > 0) {
    L.push(...item('gst/gstr1-YYYY-MM.json', `GSTR-1 files in the format the GST portal's offline tool takes, one per month that had sales or notes (${input.gstr1.include.map((g) => g.month).join(', ')}).`));
  }
  L.push(...item('MANIFEST.sha256', 'The SHA-256 fingerprint of every other file, to prove nothing was damaged or altered (see below).'));

  L.push('THE DATA FILES', '');
  for (const f of input.dataFiles) L.push(...wrap(`${f.path}${f.rows === null ? '' : ` (${f.rows} rows)`}: ${f.description}`, 96, '  ').map((l, i) => (i === 0 ? l : `    ${l.trimStart()}`)));
  L.push('');

  L.push('CHECKING THAT THE FILES ARE INTACT', '');
  L.push(...para('Unpack the whole zip into a folder, open a terminal in that folder and run one of these. Every line should say OK.'));
  L.push('  Mac        : shasum -a 256 -c MANIFEST.sha256', '  Linux      : sha256sum -c MANIFEST.sha256', '  Windows    : Get-FileHash -Algorithm SHA256 <file>   (PowerShell; compare with the line for that file)', '');

  L.push('A NOTE ON TALLY (please read before relying on it)', '');
  L.push(...para('The two files in the tally folder were generated to Tally\'s documented XML import format. They have NOT yet been imported into a live Tally. Before relying on them, have your CA test-import them into a copy company first.'));
  L.push(...para(`How: import tally/masters.xml first (${input.tally.ledgers} ledgers under Tally's default groups, opening balance 0), then tally/vouchers.xml (${input.tally.vouchers} vouchers). ${input.tally.hasOpeningVoucher ? 'The first voucher, dated 1 April and numbered OPENING, is a Journal that carries the balances brought forward from earlier years; last year\'s profit and loss is netted into one ledger called "Profit and Loss brought forward". ' : 'This is the first year in the books, so there is no carried-forward voucher: the go-live opening entry is an ordinary Journal voucher of the year. '}Every voucher balances to the paisa, and for every account the opening voucher plus the year's vouchers was checked against the trial balance; if either check had failed the export would have refused to run.`));
  L.push(...para('Voucher numbers are the document numbers (DN/..., PB/..., RCPT/...). Tally keeps our numbers only for voucher types set to Manual numbering; with Automatic numbering it assigns its own and drops ours. Our document number is also written in each voucher\'s narration, so it is never lost. Set Sales, Purchase, Receipt, Payment, Contra, Journal, Credit Note and Debit Note to Manual numbering before importing if you want to keep them.'));
  L.push(...para('Inventory and Goods in Transit are ledgers under Current Assets, not Stock-in-Hand: Tally may refuse to post ledgers of the Stock-in-Hand group in plain vouchers when accounts are integrated with inventory. Your CA can move them to Stock-in-Hand after the import if the company is set up for it. Only accounts are exported, not stock items or quantities; the stock sheets of books.xlsx and data/*.json carry those. Cancelled documents are exported together with their reversing entries (flagged in the narration), so that, once imported, Tally\'s trial balance should match the app\'s. That has not yet been confirmed in a live Tally.'));

  L.push('INVOICE PDFs ARE NOT IN HERE', '');
  L.push(...para('Rendering thousands of invoices inside one download is not safe, so invoice PDFs are not bundled. Every invoice field (lines, HSN, tax split, totals, party) is in books.xlsx and the JSON files, and any single invoice can be printed again as a PDF from the app in one click.'));

  L.push('GST RETURNS', '');
  if (input.gstr1.include.length > 0) L.push(...para(`gst/ has a GSTR-1 file for each month that had sales or notes. Check the first upload on the portal, as with any file made outside the portal.`));
  else L.push(...para('There are no GSTR-1 files in this archive.'));
  for (const n of input.gstr1.notes) L.push(...para(n));

  L.push('SELF-CHECKS', '');
  L.push(...para(input.trialBalanceBalanced ? `The trial balance on ${formatDate(ctx.fy.to)} balances (total debits equal total credits).` : `WARNING: the trial balance on ${formatDate(ctx.fy.to)} does NOT balance. Tell the person who keeps the books.`));
  L.push(...para('More checks are on the last sheet of books.xlsx (journal totals, row counts written against row counts expected, documents that changed while the export ran).'));

  const left = [...input.omittedReports, ...input.skippedSheets.map((s) => `${s.sheet}: ${s.reason}`)];
  if (left.length > 0) {
    L.push('LEFT OUT OF THIS ARCHIVE', '');
    for (const o of left) L.push(...para(o));
  }
  L.push('NOT INCLUDED ANYWHERE', '');
  L.push(...para('Bill photos and other attachments, sign-in accounts and security settings, per-person salary rates, quotations, and delivery-challan and stock-transfer headers (their effect on the books is in the journal and the stock movements).'));
  return `${L.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
