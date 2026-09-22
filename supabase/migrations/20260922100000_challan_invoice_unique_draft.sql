-- Change 11 follow-up: closes a concurrency gap found while building the challans UI.
-- `convertChallanToInvoice` (src/app/actions/challans.ts) is idempotent by application logic
-- alone (select-then-insert): two genuinely simultaneous calls for the same open challan could
-- both pass the "no existing draft yet" check and each insert a draft sales_invoice pointing at
-- the same challan. That never corrupts the books -- post_sales_invoice's existing DN_CONVERTED
-- check (change 05) refuses to post the second one -- but it could leave a stray duplicate draft
-- behind. This index makes the app-level check race-proof: only one draft per challan can exist
-- at the database level, ever. The action now also recovers cleanly from the race (catches the
-- unique-violation and returns the winner's draft id) rather than surfacing it as a failure.
--
-- Scoped to status = 'draft' (not a plain unique index on challan_id): a challan that was
-- invoiced, then had that invoice cancelled, is reopened (invoice_id set back to null) and may
-- legitimately be invoiced again -- the first, now-cancelled invoice keeps its own row with the
-- same challan_id, and a fresh draft for the same challan must still be insertable.
create unique index sales_invoices_one_draft_per_challan
  on sales_invoices (challan_id)
  where status = 'draft' and challan_id is not null;
