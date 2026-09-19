-- Change 05: posting-challan-transfer-adjust-dayclose — migration A of two.
--
-- db-architecture spec: "Schema extensions for prototype-v2 features" (enum deltas) +
-- "Implementation clarifications" -> Enum extensions (change 05).
--
-- This file contains NOTHING but the ALTER TYPE ... ADD VALUE statements, deliberately.
-- Postgres lets a new enum value be added inside a transaction, but the value cannot be
-- *used* until that transaction commits ("unsafe use of new value of enum type"), and the
-- Supabase CLI applies each migration file in its own transaction. So the tables, seeds and
-- posting functions that reference 'delivery_challan' / 'stock_transfer' / 'day_close' live
-- in the next file (20260918140100), which runs in a later transaction.
--
-- 'stock_adjustment', 'opening' and 'manual' were already in the original enum (change 01).
-- 'quotation' never posts a journal entry; it exists so a QT doc_sequences row can carry a
-- doc_type in Phase 2 (quotations themselves are out of scope for change 05).

alter type source_type add value if not exists 'delivery_challan';
alter type source_type add value if not exists 'stock_transfer';
alter type source_type add value if not exists 'quotation';
alter type source_type add value if not exists 'day_close';
