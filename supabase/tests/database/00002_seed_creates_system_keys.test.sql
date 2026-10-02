-- Must pass (change 01, foundation-schema): "seed creates all system_key rows"
-- Every system_key named in db-architecture spec's "Core tables" (15) and "Schema extensions
-- for prototype-v2 features" -> "New system_key accounts" (10) exists exactly once.
--
-- Count/list updated by change 03's migration (pre-implementation audit, 2026-09-16): the audit
-- retroactively assigns system_key to 7 more accounts ('sales_cement'/'sales_steel'/'sales_other'
-- plus 'freight_recovered'/'discount_received'/'salaries'/'godown_rent') via an UPDATE in that
-- migration, so this frozen count moves from 25 to 32. This is a deliberate, spec-directed
-- change to change 01's own acceptance criteria (not an accidental break — see change 03's
-- implementation-notes.md), made by the same authority that owns this spec section.
--
-- Moves again, 32 -> 33, with change 04's migration: 'cheques_in_hand' (account 1130) is named
-- in the spec's payments-columns paragraph and explicitly assigned to change 04 by the
-- "Payments: discount and cheques" clarification ("add system_key + account 1130 in change 04").
-- Change 01's seed comment already records that this one key was deliberately deferred to here,
-- so this edit is the planned completion of that deferral, not a break.
-- Moves again, 33 -> 34, with change 17's migration: 'opening_balance_equity' (account 3900), named by
-- the spec's "Opening balances (change 17)" section ("add system_key + account 3900").
-- Moves again, 34 -> 35, with change 22's migration: 'bank_charges' (account 5950), the ledger a
-- bank charge found on an imported statement is booked to.
begin;

create extension if not exists pgtap with schema extensions;

select plan(2);

select is(
  (select count(*)::int from accounts where system_key is not null),
  35,
  'exactly 35 system_key accounts are seeded (25 original + 7 from change 03 + 1 from change 04 + 1 from change 17 + 1 from change 22)'
);

select set_eq(
  $$ select system_key from accounts where system_key is not null $$,
  ARRAY[
    -- Core tables (15)
    'ar', 'ap', 'inventory', 'cogs', 'output_cgst', 'output_sgst', 'output_igst',
    'input_cgst', 'input_sgst', 'input_igst', 'round_off', 'salary_payable',
    'employee_advance', 'cash', 'rcm_payable',
    -- Schema extensions "New system_key accounts" (10)
    'bank', 'cash_over_short', 'rebate_income', 'rebate_receivable', 'stock_loss',
    'freight_inward', 'loading_unloading', 'discount_allowed', 'interest_income',
    'goods_in_transit',
    -- Change 03 migration retrofit (7)
    'sales_cement', 'sales_steel', 'sales_other', 'freight_recovered',
    'discount_received', 'salaries', 'godown_rent',
    -- Change 04 migration (1): the cheque lifecycle's own ledger
    'cheques_in_hand',
    -- Change 17 migration (1): the balancing side of the opening entry
    'opening_balance_equity',
    -- Change 22 migration (1): bank charges booked from a statement line
    'bank_charges'
  ],
  'every spec-named system_key exists as exactly one accounts row'
);

select * from finish();

rollback;
