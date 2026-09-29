-- Change 21a (purchases-ui): one posted bill per supplier bill number.
--
-- The tax credit is claimed against the supplier's own bill number. Entering the same bill twice
-- would claim its input tax twice, and nothing in the schema stopped it. The index is on posted
-- bills only: drafts are half-typed and may repeat a number until one of them is posted, and a
-- cancelled bill frees its number so a corrected copy can be entered again. Case and surrounding
-- spaces do not count ("sup/001 " is "SUP/001"). Bills without a number (opening entries, older
-- rows) are outside it.
create unique index purchase_invoices_supplier_bill_uniq
  on purchase_invoices (party_id, upper(btrim(supplier_bill_no)))
  where status = 'posted' and supplier_bill_no is not null and btrim(supplier_bill_no) <> '';
