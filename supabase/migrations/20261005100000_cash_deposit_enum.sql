-- Change 23: cash-deposit — migration A of two.
--
-- Nothing but the ALTER TYPE, for the reason change 05's enum file gives: Supabase applies each
-- migration in its own transaction and a new enum value cannot be used until that transaction
-- commits. The table, function and cancel branch that use 'cash_deposit' are in the next file.
alter type source_type add value if not exists 'cash_deposit';
