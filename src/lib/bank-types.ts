// Shapes the bank reconciliation screens pass between server components and the client pieces.
// Every money value is a decimal string (never a float).

export type LineStatus = 'matched' | 'suggested' | 'unmatched' | 'ignored';
export const LINE_STATUSES: readonly LineStatus[] = ['matched', 'suggested', 'unmatched', 'ignored'];

export interface Suggestion {
  entryId: string;
  paymentId: string | null;
  kind: string;
  entryNo: string | null;
  entryDate: string;
  narration: string | null;
  amount: string;
  reason: string;
}

export interface BankLine {
  id: string;
  lineNo: number | null;
  txnDate: string;
  valueDate: string | null;
  narration: string;
  reference: string | null;
  debit: string;
  credit: string;
  balance: string | null;
  status: LineStatus;
  ignoreReason: string | null;
  matchedEntryId: string | null;
  matchedPaymentId: string | null;
  /** Set when the matched payment is a cheque still waiting to be marked cleared. */
  chequeToClear: boolean;
  suggestion: Suggestion | null;
}

/** A book entry on the bank ledger a line could be matched to (`v_bank_book_items`, matchable and still free). */
export interface BookItem {
  entryId: string;
  entryNo: string | null;
  entryDate: string;
  narration: string | null;
  sourceType: string;
  direction: 'in' | 'out';
  amount: string;
  instrumentNo: string | null;
}

export interface StatementSummary {
  id: string;
  periodFrom: string;
  periodTo: string;
  sourceFile: string | null;
  lineCount: number;
  unmatchedCount: number;
  matchedCount: number;
  ignoredCount: number;
  totalDebit: string;
  totalCredit: string;
  openingBalance: string | null;
  closingBalance: string | null;
}

export interface ReconSummary {
  bankBalance: string | null;
  bookBalance: string;
  difference: string | null;
  unmatchedLines: number;
  unexplained: string | null;
  /** Unmatched book items before the first imported line, less the bank balance implied there (0 when books and statements start together). */
  openingDifference: string | null;
  /** Entries on the bank ledger no statement line matches. */
  bookOnlyEntries: number;
  /** Statement lines (unmatched or ignored) no book entry matches. */
  bankOnlyLines: number;
  explained: boolean | null;
  statementId: string | null;
  asAt: string | null;
}

export interface ExpenseAccountOption {
  id: string;
  name: string;
  isBankCharges: boolean;
}
