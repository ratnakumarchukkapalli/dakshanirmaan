// Shapes the payments screens pass between server components and the client form. Every money
// value is a decimal string (never a float).

export interface PaymentParty {
  id: string;
  name: string;
  type: 'customer' | 'supplier' | 'both';
  isActive: boolean;
  /** What the party owes us (AR), 2 decimals. */
  arBalance: string;
  /** What we owe the party (AP), 2 decimals. */
  apBalance: string;
}

export interface FormAccount {
  id: string;
  name: string;
  systemKey: string | null;
}

/** One row from `v_open_sales_invoices` (a receipt) or `v_open_purchase_invoices` (a payment). */
export interface OpenInvoiceForAlloc {
  invoiceType: 'sales_invoice' | 'purchase_invoice';
  invoiceId: string;
  partyId: string;
  docNo: string;
  docDate: string;
  ageDays: number;
  /** 2 decimals — this row's own outstanding amount, the cap on any allocation against it. */
  openAmount: string;
}

export interface PaymentFormContext {
  parties: PaymentParty[];
  accounts: FormAccount[];
  openInvoices: OpenInvoiceForAlloc[];
  /** Today's business date (ISO) in the organisation's time zone. */
  today: string;
  /** Whether the current session is a verified admin (gates the discount field and the Pay direction). */
  isAdmin: boolean;
}

export interface PaymentFormValues {
  direction: 'receipt' | 'payment';
  partyId: string;
  paymentDate: string;
  mode: 'cash' | 'upi' | 'neft' | 'cheque' | 'bank';
  instrumentNo: string;
  instrumentDate: string;
  chequeBank: string;
  amount: string;
  discount: string;
  accountId: string;
  note: string;
  allocations: { invoiceType: 'sales_invoice' | 'purchase_invoice'; invoiceId: string; amount: string }[];
}

export interface PaymentFormInitial {
  id: string;
  updatedAt: string;
  values: PaymentFormValues;
}

export interface PaymentListRow {
  id: string;
  voucherNo: string | null;
  direction: 'receipt' | 'payment';
  paymentDate: string;
  partyName: string;
  mode: 'cash' | 'upi' | 'neft' | 'cheque' | 'bank';
  instrumentNo: string | null;
  chequeBank: string | null;
  amount: string;
  status: 'draft' | 'posted' | 'cancelled';
  chequeStatus: 'in_hand' | 'deposited' | 'cleared' | 'bounced' | 'issued' | 'presented' | null;
  /** Doc references this payment settled, for the Allocated column ("On account" when empty). */
  allocatedRefs: string[];
}

export interface PaymentTiles {
  receivedToday: string;
  chequesInHand: string;
  chequesIssued: string;
  unallocated: string;
}

/** The unmatched bank statement line a receipt/payment is being recorded from (`/payments/new?bankLine=`). */
export interface BankLineSource {
  lineId: string;
  statementId: string;
  /** ISO date of the line. */
  txnDate: string;
  /** The amount on the line (credit for a receipt, debit for a payment), 2 decimals. */
  amount: string;
  narration: string;
}
