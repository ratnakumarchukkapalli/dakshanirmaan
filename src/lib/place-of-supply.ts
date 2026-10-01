// Which state decides the tax head (CGST+SGST vs IGST) on a sale. One rule, used by the invoice form's preview and by
// the save action, so the two cannot drift: the chosen delivery site's state, else the customer's default (billing)
// address, else the customer's own state. The database derives it again when it posts (`post_sales_invoice`), from its
// own copy of the addresses, so this only decides what the draft and the preview show.

export interface PlaceSite {
  id: string;
  stateCode: string;
  /** The customer's default address (the billing one). */
  isBilling: boolean;
}

export function derivePlaceOfSupply(sites: PlaceSite[], siteId: string | null | undefined, partyState: string | null | undefined): string | null {
  const chosen = siteId ? sites.find((s) => s.id === siteId) : undefined;
  if (chosen) return chosen.stateCode;
  const billing = sites.find((s) => s.isBilling);
  return billing?.stateCode ?? partyState ?? null;
}
