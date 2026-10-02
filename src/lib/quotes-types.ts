// Shapes the quotation screens pass between server components and the client form. Every
// quantity and rate is a decimal string (never a float); `updatedAt` is the database's own text,
// sent back unchanged (never through a Date: that would drop microseconds and fail as a conflict).

export interface QuoteFormValues {
  partyId: string;
  quoteDate: string;
  /** '' = let the database default it (quote date + 7 days). */
  validUntil: string;
  note: string;
  lines: { itemId: string; qty: string; altQty: string; rate: string; discountPct: string }[];
}

export interface QuoteFormInitial {
  id: string;
  quoteNo: string;
  updatedAt: string;
  values: QuoteFormValues;
}
