-- db-architecture spec: "Indexes (baseline, Phase 1)"
create index on journal_lines (party_id, entry_id);
create index on journal_lines (account_id, entry_id);
create index on journal_entries (entry_date);
create index on journal_entries (source_type, source_id);
create index on stock_movements (item_id, warehouse_id, movement_date);
create index on sales_invoices (party_id, invoice_date desc);
create index on sales_invoices (status) where status = 'draft';
create index on purchase_invoices (party_id, invoice_date desc);
create index on payment_allocations (invoice_id);
create index on payments (party_id, payment_date desc);
create index on audit_log (entity, entity_id);
