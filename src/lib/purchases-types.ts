// Shapes the purchase screens pass between server components and the client form. Every money and
// quantity is a decimal string (never a float).

export interface BillSupplier {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string;
  isActive: boolean;
  /** What the business owes this supplier today (AP balance), 2 decimals. */
  owed: string;
}

export interface BillItem {
  id: string;
  name: string;
  brand: string | null;
  hsn: string;
  gstRate: string;
  baseUom: string;
  altUom: string | null;
  /** 1 alt unit = factor base units, 4 decimals. */
  factor: string | null;
  isActive: boolean;
}

export interface BillFormContext {
  /** Suppliers (and "both"); an existing draft keeps its supplier even if disabled since. */
  suppliers: BillSupplier[];
  /** Stock items only: a service on an inward bill is refused by the database. */
  items: BillItem[];
  /** The organisation's own state: the supplier's state decides CGST+SGST versus IGST. */
  orgState: string;
  /** Today's business date (ISO) in the organisation's time zone. */
  today: string;
}

export interface BillFormValues {
  partyId: string;
  invoiceDate: string;
  supplierBillNo: string;
  supplierBillDate: string;
  itcEligible: boolean;
  lines: { itemId: string; qty: string; altQty: string; rate: string; discountPct: string }[];
}

export interface BillFormInitial {
  id: string;
  updatedAt: string;
  values: BillFormValues;
}
