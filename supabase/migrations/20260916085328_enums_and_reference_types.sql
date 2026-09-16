-- db-architecture spec: "Enums and reference types"
create type account_type as enum ('asset','liability','equity','income','expense');
create type party_type as enum ('customer','supplier','both','employee');
create type doc_status as enum ('draft','posted','cancelled');
create type source_type as enum (
  'sales_invoice','purchase_invoice','credit_note','debit_note',
  'payment','expense_voucher','stock_adjustment','opening','manual'
);
create type payment_mode as enum ('cash','upi','neft','cheque','bank');
create type app_role as enum ('admin','user');
