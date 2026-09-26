-- Change 12 review fix: the payment form has a free-text note field (proposal), and the /payments/new
-- resume-draft query selects `payments.note`, but no earlier migration ever created the column, so
-- resuming any saved draft failed (untyped client + mocked unit tests hid it). Plain nullable text.
-- No RLS/grant/trigger change is needed: payments' RLS policies are row-level (status = 'draft')
-- and the table has no column allow-lists or column-freezing triggers.
alter table payments add column note text;
