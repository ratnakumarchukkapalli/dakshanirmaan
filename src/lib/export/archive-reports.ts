import 'server-only';
import { loadBalanceSheet, loadPnl, type StatementRow } from '@/lib/books-data';
import { formatDate } from '@/lib/format';
import { loadAgeingAsAt } from './ageing-asat';
import { gstMonthlyTable, stockOnHandTable, type BooksPrep } from './books-tables';
import { sumDecimal, toScaled } from './decimal';
import type { Lookups } from './lookups';
import { collect } from './paged';
import { generatedAtText } from './period';
import { groupIndian, type ReportRow, type ReportSpec } from './report-pdf';
import type { ExportContext, ExportRow } from './types';

// The six statements of the year archive, as data for the generic report PDF. Every figure is the
// database's own (trial balance, profit and loss and balance sheet functions, the stock and GST
// tables of the workbook) or an exact decimal sum of them; nothing is computed in floating point.

type Ctx = ExportContext;

export interface ArchiveReports {
  /** Archive path -> what to print, in the order they go into the zip. */
  files: { path: string; spec: ReportSpec }[];
  /** Stock on hand rows, kept so the JSON file of the same table does not read the movements a third time. */
  stockRows: ExportRow[];
  /** Reports left out, with the reason (shown in the README). */
  omitted: string[];
}

const money = (v: string | null | undefined) => groupIndian(v, 2);

export async function prepareReports(ctx: Ctx, prep: BooksPrep, lk: Lookups): Promise<ArchiveReports> {
  const header = {
    orgName: ctx.orgName,
    period: `Financial year ${ctx.fy.label}   (${formatDate(ctx.fy.from)} to ${formatDate(ctx.fy.to)})`,
    asOf: `Data as of ${generatedAtText(new Date(ctx.asOf), ctx.timeZone)}`,
  };
  const files: ArchiveReports['files'] = [];
  const omitted: string[] = [];

  // ---- trial balance (already read for the workbook)
  const tb = prep.trialBalance;
  files.push({
    path: 'reports/trial-balance.pdf',
    spec: {
      ...header, title: 'Trial balance', subtitle: `Closing balance of every ledger account on ${formatDate(ctx.fy.to)}, all entries up to that day.`,
      columns: [{ header: 'Code', width: 9 }, { header: 'Account', width: 40 }, { header: 'Type', width: 12 }, { header: 'Debit', width: 17, align: 'right' }, { header: 'Credit', width: 17, align: 'right' }],
      rows: [
        ...tb.rows.map((r): ReportRow => ({ cells: [r.code, r.name, r.type, r.debit === '0.00' ? '' : money(r.debit), r.credit === '0.00' ? '' : money(r.credit)] })),
        { cells: ['', 'Total', '', money(tb.totalDebit), money(tb.totalCredit)], bold: true, rule: true },
      ],
      notes: [tb.balanced ? 'Check: total debits equal total credits.' : 'CHECK FAILED: total debits differ from total credits.'],
    },
  });

  // ---- profit and loss
  const pnl = await loadPnl(ctx.supabase, ctx.fy.from, ctx.fy.to);
  const statementRows = (list: StatementRow[]): ReportRow[] => list.map((r) => ({ cells: [r.code ?? '', r.name, money(r.amount)] }));
  files.push({
    path: 'reports/profit-and-loss.pdf',
    spec: {
      ...header, title: 'Profit and loss', subtitle: `${formatDate(ctx.fy.from)} to ${formatDate(ctx.fy.to)}.`,
      columns: [{ header: 'Code', width: 10 }, { header: 'Account', width: 62 }, { header: 'Amount', width: 20, align: 'right' }],
      rows: [
        { cells: ['Income'], section: true },
        ...statementRows(pnl.income),
        { cells: ['', 'Total income', money(pnl.totalIncome)], bold: true, rule: true },
        { cells: ['Expenses'], section: true },
        ...statementRows(pnl.expenses),
        { cells: ['', 'Total expenses', money(pnl.totalExpenses)], bold: true, rule: true },
        { cells: ['', toScaled(pnl.net, 2) >= 0n ? 'Net profit' : 'Net loss', money(pnl.net)], bold: true, rule: true },
      ],
    },
  });

  // ---- balance sheet
  const bs = await loadBalanceSheet(ctx.supabase, ctx.fy.to);
  files.push({
    path: 'reports/balance-sheet.pdf',
    spec: {
      ...header, title: 'Balance sheet', subtitle: `As at ${formatDate(ctx.fy.to)}. Profit not yet moved to capital is shown as a separate line under equity.`,
      columns: [{ header: 'Code', width: 10 }, { header: 'Account', width: 62 }, { header: 'Amount', width: 20, align: 'right' }],
      rows: [
        { cells: ['Assets'], section: true },
        ...statementRows(bs.assets),
        { cells: ['', 'Total assets', money(bs.totalAssets)], bold: true, rule: true },
        { cells: ['Liabilities'], section: true },
        ...statementRows(bs.liabilities),
        { cells: ['', 'Total liabilities', money(bs.totalLiabilities)], bold: true, rule: true },
        { cells: ['Equity'], section: true },
        ...statementRows(bs.equity),
        { cells: ['', 'Total equity', money(bs.totalEquity)], bold: true, rule: true },
        { cells: ['', 'Total liabilities and equity', money(bs.totalLiabilitiesEquity)], bold: true, rule: true },
      ],
      notes: [bs.balanced ? 'Check: total assets equal total liabilities and equity.' : 'CHECK FAILED: total assets differ from total liabilities and equity.'],
    },
  });

  // ---- receivables ageing as at the year end
  const closing = (code: string): bigint => {
    const row = tb.rows.find((r) => r.code === code);
    return row ? toScaled(row.debit, 2) - toScaled(row.credit, 2) : 0n;
  };
  const ageing = await loadAgeingAsAt(ctx, lk, closing);
  const ageNotes = [
    'Built from the ledger: each party\'s receipts and credit notes are set against the oldest debits first, and what remains is aged from the date of the entry. "On account" is money received beyond what was owed.',
  ];
  if (ageing.control !== null && ageing.withoutParty !== null) {
    ageNotes.push(ageing.withoutParty === '0.00'
      ? `Check: the parties add up to the receivables account in the trial balance (${money(ageing.control)}).`
      : `The receivables account in the trial balance is ${money(ageing.control)}; ${money(ageing.withoutParty)} of it is on entries that name no party.`);
  }
  files.push({
    path: 'reports/receivables-ageing.pdf',
    spec: {
      ...header, title: 'Receivables ageing', subtitle: `What each party owed on ${formatDate(ctx.fy.to)}, by age of the debit.`, landscape: true,
      columns: [
        { header: 'Party', width: 30 }, { header: '0-30 days', width: 12, align: 'right' }, { header: '31-60 days', width: 12, align: 'right' },
        { header: '61-90 days', width: 12, align: 'right' }, { header: 'Over 90 days', width: 12, align: 'right' }, { header: 'On account (credit)', width: 13, align: 'right' }, { header: 'Net receivable', width: 13, align: 'right' },
      ],
      rows: [
        ...ageing.rows.map((r): ReportRow => ({ cells: [r.party, money(r.b0_30), money(r.b31_60), money(r.b61_90), money(r.b90_plus), money(r.onAccount), money(r.net)] })),
        { cells: ['Total', money(ageing.totals.b0_30), money(ageing.totals.b31_60), money(ageing.totals.b61_90), money(ageing.totals.b90_plus), money(ageing.totals.onAccount), money(ageing.totals.net)], bold: true, rule: true },
      ],
      notes: ageNotes,
    },
  });

  // ---- stock valuation as at the year end (the workbook's Stock on hand table)
  const stockRows = await collect(stockOnHandTable(ctx, lk).rows());
  const stockValue = sumDecimal(stockRows.map((r) => String(r[6] ?? '0.00')), 2);
  files.push({
    path: 'reports/stock-valuation.pdf',
    spec: {
      ...header, title: 'Stock valuation', subtitle: `Quantity and value on hand on ${formatDate(ctx.fy.to)}, per item and godown, at weighted-average cost.`, landscape: true,
      columns: [
        { header: 'Item', width: 34 }, { header: 'Unit', width: 7 }, { header: 'Godown', width: 20 }, { header: 'Quantity', width: 12, align: 'right' },
        { header: 'Average rate', width: 13, align: 'right' }, { header: 'Value', width: 14, align: 'right' },
      ],
      rows: [
        ...stockRows.map((r): ReportRow => ({ cells: [String(r[0] ?? ''), String(r[1] ?? ''), `${String(r[2] ?? '')}${r[3] === true ? ' (in transit)' : ''}`, groupIndian(r[4] as string, 3), groupIndian(r[5] as string, 4), money(r[6] as string)] })),
        { cells: ['Total', '', '', '', '', money(stockValue)], bold: true, rule: true },
      ],
    },
  });

  // ---- GST summary (the workbook's month-wise GSTR-3B figures)
  if (prep.gst.ok) {
    const gstRows = await collect(gstMonthlyTable(ctx, prep.gst).rows());
    files.push({
      path: 'reports/gst-summary.pdf',
      spec: {
        ...header, title: 'GST summary', subtitle: 'Month by month: output tax, input tax credit and the ledger figure each is compared with (the figures of the GST screens).', landscape: true,
        columns: [
          { header: 'Month', width: 8 }, { header: 'Row', width: 7 }, { header: 'What', width: 37 }, { header: 'Taxable value', width: 14, align: 'right' },
          { header: 'IGST', width: 11, align: 'right' }, { header: 'CGST', width: 11, align: 'right' }, { header: 'SGST', width: 11, align: 'right' },
        ],
        rows: gstRows.map((r): ReportRow => ({ cells: [String(r[0] ?? ''), String(r[1] ?? ''), String(r[2] ?? ''), money(r[3] as string), money(r[4] as string), money(r[5] as string), money(r[6] as string)] })),
      },
    });
  } else {
    omitted.push(`reports/gst-summary.pdf: ${prep.gst.reason}`);
  }

  return { files, stockRows, omitted };
}

