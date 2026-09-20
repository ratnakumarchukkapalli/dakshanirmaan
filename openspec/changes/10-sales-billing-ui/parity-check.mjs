// MANUAL CHECK (not part of the build or the test suite): proves the billing screen's totals preview
// equals what the real post_sales_invoice function stores. Posts each case inside one transaction
// that is rolled back, then compares. Needs the local Supabase DB container and Node >= 23.6.
//   node openspec/changes/10-sales-billing-ui/parity-check.mjs
// SQL-backed parity check: posts each case through the REAL post_sales_invoice inside one
// transaction (rolled back) and compares the stored totals with the TypeScript preview.
// Usage: node run.mjs   (local Supabase DB container must be running)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const src = path.join(repo, 'src/lib');
const here = mkdtempSync(path.join(os.tmpdir(), 'dn-parity-'));
// Copy the real modules, rewriting the alias so Node can import them directly.
for (const f of ['decimal', 'invoice-math', 'units']) {
  writeFileSync(path.join(here, `${f}.ts`), readFileSync(`${src}/${f}.ts`, 'utf8').replaceAll("'@/lib/decimal'", "'./decimal.ts'"));
}
const { previewTotals } = await import(path.join(here, 'invoice-math.ts'));

const L = (qty, rate, discountPct, gstRate, category = 'cement') => ({ qty, rate, discountPct, gstRate, category });
const CASES = [
  ['cement intra', true, [L('100', '385.0000', '0', '28')]],
  ['cement inter', false, [L('100', '385.0000', '0', '28')]],
  ['tmt 1200kg', true, [L('1200.000', '58.0000', '0', '18', 'steel')]],
  ['fractional discount', true, [L('37.500', '412.3350', '2.50', '18')]],
  ['three lines intra', true, [L('10.000', '1234.5678', '0', '18'), L('3.333', '99.9999', '5', '28', 'steel'), L('0.500', '7.7777', '12.5', '5', 'other')]],
  ['three lines inter', false, [L('10.000', '1234.5678', '0', '18'), L('3.333', '99.9999', '5', '28', 'steel'), L('0.500', '7.7777', '12.5', '5', 'other')]],
  ['half-paise tax', true, [L('1', '1.0000', '0', '5')]],
  ['half-rupee total', true, [L('1', '0.5000', '0', '0')]],
  ['tax below a paisa', true, [L('1.000', '10.1000', '0', '5')]],
  ['zero gst', true, [L('5.000', '50.0000', '0', '0')]],
  ['gst 12.50 disc 3.25', true, [L('7.000', '111.1100', '3.25', '12.50')]],
  ['large', true, [L('99999.999', '9999.9999', '0', '28')]],
  ['many lines', true, Array.from({ length: 12 }, (_, i) => L(String(i + 1) + '.125', (17.31 + i * 3.3337).toFixed(4), String((i * 1.75).toFixed(2)), ['5', '12', '18', '28'][i % 4], ['cement', 'steel', 'other'][i % 3]))],
];

let sql = `begin;
create temp table parity_out(name text, taxable numeric, cgst numeric, sgst numeric, igst numeric, round_off numeric, grand numeric, line_taxables text);
`;
sql += `insert into parties (id, name, type, state_code, credit_limit) values ('aaaaaaaa-0000-4000-8000-000000000001','Parity Intra','customer','37',null),('aaaaaaaa-0000-4000-8000-000000000002','Parity Inter','customer','36',null);\n`;
let n = 0;
for (const [, intra, lines] of CASES) {
  n++;
  const inv = `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
  sql += `insert into sales_invoices (id, invoice_date, party_id, place_of_supply, warehouse_id) values ('${inv}','2026-09-20','aaaaaaaa-0000-4000-8000-00000000000${intra ? 1 : 2}','${intra ? '37' : '36'}',(select id from warehouses where is_default));\n`;
  lines.forEach((l, i) => {
    const item = `cccccccc-${String(n).padStart(4, '0')}-4000-8000-${String(i + 1).padStart(12, '0')}`;
    sql += `insert into items (id,name,category,hsn_code,gst_rate,base_uom,sale_rate) values ('${item}','P${n}-${i}','${l.category}','2523',${l.gstRate},'kg',1);\n`;
    sql += `insert into stock_movements (item_id,warehouse_id,movement_date,qty,rate,value,source_type) select '${item}', id, '2026-09-01', 1000000, 10, 10000000, 'opening' from warehouses where is_default;\n`;
    sql += `insert into sales_invoice_lines (invoice_id,line_no,item_id,item_name,hsn_code,uom,qty,rate,discount_pct,gst_rate) values ('${inv}',${i + 1},'${item}','P${n}-${i}','2523','kg',${l.qty},${l.rate},${l.discountPct},${l.gstRate});\n`;
  });
}
sql += `select set_config('request.jwt.claims', json_build_object('sub',(select user_id from app_users where role='admin' limit 1),'role','authenticated','aal','aal2')::text, true);\nset local role authenticated;\n`;
for (let i = 1; i <= CASES.length; i++) sql += `select post_sales_invoice('bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}');\n`;
sql += `reset role;\n`;
sql += `select json_agg(json_build_object('taxable', i.taxable_total, 'cgst', i.cgst_total, 'sgst', i.sgst_total, 'igst', i.igst_total, 'roundOff', i.round_off, 'grand', i.grand_total,
  'lines', (select json_agg(l.taxable_value::text order by l.line_no) from sales_invoice_lines l where l.invoice_id = i.id))) from (select * from sales_invoices where id::text like 'bbbbbbbb%' order by id) i;\nrollback;\n`;

const out = execFileSync('docker', ['exec', '-i', 'supabase_db_Daksh_Nirmaan', 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
const json = out.split('\n').find((l) => l.startsWith('[{'));
if (!json) { console.error(out); process.exit(2); }
const rows = JSON.parse(json);
// json_agg order is not guaranteed to match case order: match on grand+taxable via posting id order instead.
const byIndex = rows; // rows are ordered by invoice id, which encodes the case number
let bad = 0;
CASES.forEach(([name, intra, lines], i) => {
  const p = previewTotals(lines, intra);
  const d = byIndex[i];
  const dbv = { taxable: Number(d.taxable).toFixed(2), cgst: Number(d.cgst).toFixed(2), sgst: Number(d.sgst).toFixed(2), igst: Number(d.igst).toFixed(2), roundOff: Number(d.roundOff).toFixed(2), grand: Number(d.grand).toFixed(2) };
  const pv = { taxable: p.taxable, cgst: p.cgst, sgst: p.sgst, igst: p.igst, roundOff: p.roundOff, grand: p.grandTotal };
  const lineOk = JSON.stringify(d.lines) === JSON.stringify(p.lines.map((l) => l.taxable));
  const ok = JSON.stringify(dbv) === JSON.stringify(pv) && lineOk;
  if (!ok) bad++;
  console.log(ok ? 'OK  ' : 'FAIL', name.padEnd(22), 'grand', pv.grand, ok ? '' : `\n   preview ${JSON.stringify(pv)} ${JSON.stringify(p.lines.map((l) => l.taxable))}\n   db      ${JSON.stringify(dbv)} ${JSON.stringify(d.lines)}`);
});
console.log(bad ? `${bad} MISMATCH` : `all ${CASES.length} cases: preview == posted totals`);
process.exit(bad ? 1 : 0);
