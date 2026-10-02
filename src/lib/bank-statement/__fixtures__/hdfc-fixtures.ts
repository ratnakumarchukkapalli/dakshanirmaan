// Anonymised statement rows modelled on docs/research/hdfc-statement-format.md, rendered in both
// HDFC layouts. All names, accounts and numbers are invented. Balances are computed here with integer
// paise so the fixtures always satisfy the balance chain.

export type FxRow = {
  date: string; // dd/mm/yy
  narration: string;
  ref: string; // the Chq/Ref column as the bank prints it ('' = empty)
  valueDate: string; // dd/mm/yy
  debit: string; // '' = none
  credit: string;
};

export type FxLine = FxRow & { balance: string };

export const OPENING = '250000.00';
const ZEROS = '0000000000000000';

const row = (date: string, narration: string, ref: string, debit: string, credit: string, valueDate = date): FxRow => ({
  date,
  narration,
  ref,
  valueDate,
  debit,
  credit,
});

export const ROWS: FxRow[] = [
  row('01/10/26', 'UPI-ACME TRADERS-acmetr01@okicici-ICIC0DC0099-427510653284-NA', '0000427510653284', '', '147418.35'),
  row('01/10/26', 'IMPS-428708302983-ACME CREATIONS-HDFC-XXXXXXXXXX1234-NA', '0000428708302983', '', '10000.00'),
  row('01/10/26', 'IMPS-428708302984-ACME CREATIONS-HDFC-XXXXXXXXXX1234-NA', '0000428708302984', '', '10000.00'),
  row('02/10/26', 'NEFT CR-YESB0000001-ACME ENTERPRISES FOR PAYEE-OWN CO NAME-YESIB42752289400', 'YESIB42752289400', '', '52000.50'),
  row('02/10/26', 'NEFT DR-SBIN0000999-PAYEE-NETBANK, MUM-N199262615', 'N199262615', '25000.00', ''),
  row('03/10/26', 'CHQ DEP MICR CLG CITY - MICR 1 CLG - NO 819021', '0000000000819021', '', '75000.00', '05/10/26'),
  row('04/10/26', 'CASH DEPOSIT BY - SELF - CITY', ZEROS, '', '20000.00'),
  row('04/10/26', 'ATW-403875XXXXXX7200-00009045-CITY', '0000540012345678', '5000.00', ''),
  row('05/10/26', '.IMPS P2A CHARGES 428708302983 INCL GST', ZEROS, '5.90', ''),
  row('05/10/26', 'ACH D- TP ACH IIL-1584396947', '0000001584396947', '1234.56', ''),
  row('06/10/26', 'REV-UPI-ACME TRADERS-acmetr01@okicici-ICIC0DC0099-427510653290-NA', '0000427510653290', '', '1234.56'),
  row('06/10/26', 'UPI-RAVI STORES-ravi@oksbi-SBIN0001234-427510653999-NA', '', '', '3000.00'),
  row('06/10/26', 'NEFT CR-HDFC0000001-KUMAR TRADING-INV 55-HDFCN52026100612345', '', '', '8000.00'),
  row('07/10/26', 'FEE-ATM CASH(1TXN)08/11/24-AOR2531733136', 'AOR2531733136080', '21.24', ''),
];

export const R0 = ROWS[0] as FxRow;
export const R1 = ROWS[1] as FxRow;

export const toPaise = (s: string): bigint => {
  if (s === '') return 0n;
  const [i = '0', f = ''] = s.split('.');
  return BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
};

export const fromPaise = (p: bigint): string => {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
};

export function withBalances(rows: FxRow[], opening = OPENING): FxLine[] {
  let bal = toPaise(opening);
  return rows.map((r) => {
    bal += toPaise(r.credit) - toPaise(r.debit);
    return { ...r, balance: fromPaise(bal) };
  });
}

/** 1234567.5 -> 12,34,567.50 (Indian grouping). */
export function indian(s: string): string {
  const [i = '', f] = s.split('.');
  const last3 = i.slice(-3);
  const rest = i.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return f === undefined ? grouped : `${grouped}.${f}`;
}

const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const pad = (s: string, n: number) => s.padEnd(n, ' ');

export const DELIMITED_HEADER =
  'Date    ,Narration                                                   ,Value Dat,Debit Amount       ,Credit Amount      ,Chq/Ref Number  ,Closing Balance';

/** Delimited layout: table only, 0.00 on the unused side, no grouping, narration NOT quoted. */
export function delimitedLine(r: FxLine): string {
  return [
    pad(r.date, 8),
    pad(r.narration, 60),
    pad(r.valueDate, 8),
    pad(r.debit || '0.00', 18),
    pad(r.credit || '0.00', 18),
    pad(r.ref, 16),
    r.balance,
  ].join(',');
}

export function delimitedText(rows: FxLine[], eol = '\n'): string {
  return [DELIMITED_HEADER, ...rows.map(delimitedLine)].join(eol) + eol;
}

export const EXCEL_HEADER = 'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance';
export const RULE = '********,********,********,********,********,********,********';

export const PREAMBLE: string[] = [
  'HDFC BANK LTD.,,,,,,',
  'Page No .: 1,,,,,,',
  'ACME TRADERS,,,,,,',
  'PLOT 12 SAMPLE ROAD,,,,,,',
  'SAMPLE CITY 500001,,,,,,',
  'Account Branch :SAMPLE CITY,,,,,,',
  'Address :SAMPLE ROAD,,,,,,',
  'City :SAMPLE CITY 500001,,,,,,',
  'State :ANDHRA PRADESH,,,,,,',
  'Phone no. :,,,,,,',
  'Currency :INR,,,,,,',
  'Email :SAMPLE@EXAMPLE.COM,,,,,,',
  'Cust ID :00000001,,,,,,',
  'Account No :50200000000000,,,,,,',
  'Statement From : 01/10/2026 To : 07/10/2026,,,,,,',
  ',,,,,,',
];

export function summaryRows(rows: FxLine[], opening = OPENING): string[] {
  const dr = rows.reduce((a, r) => a + toPaise(r.debit), 0n);
  const cr = rows.reduce((a, r) => a + toPaise(r.credit), 0n);
  const drCount = rows.filter((r) => r.debit !== '').length;
  const crCount = rows.filter((r) => r.credit !== '').length;
  const closing = rows[rows.length - 1]?.balance ?? '0.00';
  return [
    'STATEMENT SUMMARY  :-,,,,,,',
    'Opening Balance,Dr Count,Cr Count,Debits,Credits,Closing Bal,',
    [q(indian(opening)), drCount, crCount, q(indian(fromPaise(dr))), q(indian(fromPaise(cr))), q(indian(closing))].join(',') + ',',
    ',,,,,,',
    'Generated On: 08-OCT-2026 10:00:00 Generated By: SAMPLE Requesting Branch Code: 0001,,,,,,',
    'This is a computer generated statement and does not require a signature.,,,,,,',
  ];
}

/** Excel layout saved as CSV: preamble, **** rules, quoted Indian-grouped numbers, summary footer. */
export function excelCsvText(rows: FxLine[], eol = '\n', opening = OPENING): string {
  const body = rows.map((r) =>
    [
      r.date,
      q(r.narration),
      r.ref,
      r.valueDate,
      r.debit ? q(indian(r.debit)) : '',
      r.credit ? q(indian(r.credit)) : '',
      q(indian(r.balance)),
    ].join(','),
  );
  return [...PREAMBLE, EXCEL_HEADER, RULE, ...body, RULE, ...summaryRows(rows, opening)].join(eol) + eol;
}
