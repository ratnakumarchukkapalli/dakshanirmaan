// Shapes the billing screens pass between server components and the client form. Every money and
// quantity is a decimal string (never a float).

export interface FormSite {
  id: string;
  label: string;
  line1: string;
  city: string;
  pincode: string;
  stateCode: string;
  isBilling: boolean;
}

export interface FormParty {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string;
  isWalkIn: boolean;
  isActive: boolean;
  defaultSiteId: string | null;
  /** null = no limit; '0.00' = no credit at all. */
  creditLimit: string | null;
  /** What the party owes today (AR balance), 2 decimals. */
  balance: string;
  sites: FormSite[];
}

export interface FormItem {
  id: string;
  name: string;
  brand: string | null;
  hsn: string;
  gstRate: string;
  baseUom: string;
  altUom: string | null;
  /** 1 alt unit = factor base units, 4 decimals. */
  factor: string | null;
  saleRate: string;
  isStock: boolean;
  isActive: boolean;
  /** Quantity in the default godown right now (display hint only), 3 decimals. */
  onHand: string;
}

export interface FormAccount {
  id: string;
  name: string;
  systemKey: string | null;
}

export interface InvoiceFormContext {
  parties: FormParty[];
  items: FormItem[];
  accounts: FormAccount[];
  /** The organisation's own state: decides CGST+SGST versus IGST. */
  orgState: string;
  /** Today's business date (ISO) in the organisation's time zone. */
  today: string;
  /** Whether the organisation has a UPI ID (the printed invoice then carries a payment QR). */
  hasUpi: boolean;
}

export interface InvoiceFormValues {
  partyId: string;
  invoiceDate: string;
  placeOfSupply: string;
  siteId: string;
  vehicleNo: string;
  transporterName: string;
  transportMode: string;
  distanceKm: string;
  transporterGstin: string;
  lines: { itemId: string; qty: string; altQty: string; rate: string; discountPct: string }[];
}

export interface InvoiceFormInitial {
  id: string;
  updatedAt: string;
  values: InvoiceFormValues;
  /** Set when the draft was started from a delivery challan: the form then locks what the posting check compares. */
  challan?: { no: string; date: string };
}

export interface ChallanFormValues {
  partyId: string;
  challanDate: string;
  siteId: string;
  vehicleNo: string;
  lines: { itemId: string; qty: string; altQty: string; rate: string; discountPct: string }[];
}

export interface ChallanFormInitial {
  id: string;
  updatedAt: string;
  values: ChallanFormValues;
}

/** A posted, un-invoiced challan, for the "Open challans" panel. */
export interface OpenChallan {
  id: string;
  challanNo: string;
  challanDate: string;
  partyName: string;
  /** Sum of the line values (qty x rate less discount), 2 decimals. */
  value: string;
}
