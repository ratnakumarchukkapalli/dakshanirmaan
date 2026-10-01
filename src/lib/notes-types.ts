// Shapes the note screens pass between server components and the client form. Every money and
// quantity is a decimal string (never a float). A credit note is against a sales invoice, a debit
// note against a purchase bill; one set of screens serves both, switched by `kind`.
import type { NoteKind } from '@/schemas/notes';

/** Tables and routes behind each kind of note. */
export const NOTE_CONFIG = {
  credit: {
    note: 'credit_notes', lines: 'credit_note_lines', invoice: 'sales_invoices', invoiceLines: 'sales_invoice_lines',
    open: 'v_open_sales_invoices', source: 'credit_note', base: '/sales/credit-notes', invoiceBase: '/sales', list: '/sales?status=note', ns: 'notes',
  },
  debit: {
    note: 'debit_notes', lines: 'debit_note_lines', invoice: 'purchase_invoices', invoiceLines: 'purchase_invoice_lines',
    open: 'v_open_purchase_invoices', source: 'debit_note', base: '/purchases/debit-notes', invoiceBase: '/purchases', list: '/purchases?status=note', ns: 'notes',
  },
} as const satisfies Record<NoteKind, Record<string, string>>;

/** One line of the invoice or bill, with what has already been returned or adjusted by posted notes. */
export interface NoteSourceLine {
  /** The invoice line's id: what `against_line_id` points at. */
  id: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  hsn: string;
  uom: string;
  gstRate: string;
  qty: string;
  /** Quantity still returnable: invoiced minus posted returns (3 decimals). A hint; the database checks again. */
  remainingQty: string;
  taxable: string;
  /** Value still adjustable: line value minus every posted note on it (2 decimals). A hint. */
  remainingTaxable: string;
  /** TMT: pieces beside kilograms. 1 alt unit = factor base units. */
  altUom: string | null;
  factor: string | null;
}

export interface NoteSourceInvoice {
  id: string;
  number: string;
  date: string;
  partyName: string;
  partyGstin: string | null;
  grandTotal: string;
  /** Still unpaid on the invoice, or null when nothing is open (fully paid). */
  openAmount: string | null;
  /** Debit notes only: the supplier's own bill number. */
  supplierBillNo: string | null;
  lines: NoteSourceLine[];
}

export interface NoteFormContext {
  kind: NoteKind;
  invoice: NoteSourceInvoice;
  /** Today's business date (ISO) in the organisation's time zone. */
  today: string;
}

export interface NoteFormValues {
  noteDate: string;
  reason: string;
  stockEffect: boolean;
  lines: { againstLineId: string; qty: string; rate: string }[];
}

export interface NoteFormInitial {
  id: string;
  updatedAt: string;
  values: NoteFormValues;
}
