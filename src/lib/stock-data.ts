import 'server-only';
import { rows } from '@/lib/db';
import { compareDecimal, decimalText, signOf } from '@/lib/decimal';
import { todayIn } from '@/lib/format';
import { averageRate, kgToTonnes, sumStock } from '@/lib/stock-math';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;
const d3 = (v: unknown) => decimalText(v as number | string | null, 3);
const d2 = (v: unknown) => decimalText(v as number | string | null, 2);
const d4 = (v: unknown) => decimalText(v as number | string | null, 4);

export interface Godown { id: string; name: string; isDefault: boolean }

export interface StockItem {
  id: string;
  name: string;
  brand: string | null;
  category: 'cement' | 'steel' | 'other';
  hsn: string;
  baseUom: string;
  altUom: string | null;
  factor: string | null;
  reorderLevel: string;
}

export type StockLevel = 'ok' | 'low' | 'out' | 'none';

export interface StockRow {
  item: StockItem;
  qty: string;
  /** Owner-only: null for a counter session (the cost columns are never even selected). */
  avgRate: string | null;
  value: string | null;
  level: StockLevel;
}

export interface TransferInTransit {
  id: string;
  transferNo: string | null;
  transferDate: string;
  fromName: string;
  toName: string;
  vehicleNo: string | null;
  lines: { itemName: string; uom: string; qty: string }[];
}

export interface StockSummary {
  /** Today's business date (ISO) in the organisation's time zone. */
  today: string;
  godowns: Godown[];
  /** The godown shown ('all' = every real godown added up). */
  selected: string;
  rows: StockRow[];
  tiles: {
    /** Owner-only. */
    value: string | null;
    itemCount: number;
    cement: { qty: string; uom: string } | null;
    steel: { qty: string; uom: string; tonnes: string | null } | null;
    inTransit: { transfers: number; value: string | null };
  };
  transfers: TransferInTransit[];
  /** Everything the adjustment / transfer modals pick from. Quantities only. */
  form: {
    items: (StockItem & { onHand: Record<string, string> })[];
  };
}

/**
 * The stock summary. A counter session (isAdmin = false) selects only quantity columns from the
 * views — cost (average rate, value) is owner-only, and is not merely hidden on screen.
 */
export async function loadStockSummary(
  supabase: Supabase,
  opts: { warehouse: string | 'all' | undefined; isAdmin: boolean; q?: string },
): Promise<StockSummary> {
  const cols = opts.isAdmin ? 'item_id, warehouse_id, qty, value' : 'item_id, warehouse_id, qty';
  const allCols = opts.isAdmin ? 'item_id, warehouse_id, is_transit, qty, value' : 'item_id, warehouse_id, is_transit, qty';
  const [orgRes, whRes, itemRes, sumRes, transitRes, trRes] = await Promise.all([
    supabase.from('organization').select('timezone').maybeSingle(),
    supabase.from('warehouses').select('id, name, is_default, is_transit').eq('is_transit', false).order('name'),
    supabase.from('items').select('id, name, brand, category, hsn_code, base_uom, alt_uom, conversion_factor, reorder_level, is_active').eq('is_stock', true).order('name'),
    supabase.from('v_stock_summary').select(cols),
    supabase.from('v_stock_summary_all').select(allCols).eq('is_transit', true),
    supabase.from('stock_transfers').select('id, transfer_no, transfer_date, from_warehouse_id, to_warehouse_id, vehicle_no').eq('status', 'in_transit').order('transfer_date'),
  ]);
  if (orgRes.error) throw new Error(`organization: ${orgRes.error.message}`);
  const godowns: Godown[] = rows(whRes, 'godowns').map((w) => ({ id: w.id as string, name: w.name as string, isDefault: !!w.is_default }));
  const selected = opts.warehouse === 'all' ? 'all' : godowns.some((g) => g.id === opts.warehouse) ? (opts.warehouse as string) : (godowns.find((g) => g.isDefault)?.id ?? 'all');

  const itemRows = rows(itemRes, 'items');
  const sumRows = rows(sumRes, 'stock summary') as unknown as { item_id: string; warehouse_id: string; qty: number; value?: number }[];
  const inTransitRows = rows(transitRes, 'in-transit stock') as unknown as { qty: number; value?: number }[];

  const items: StockItem[] = itemRows
    .filter((i) => i.is_active || sumRows.some((s) => s.item_id === i.id && signOf(d3(s.qty)) !== 0))
    .map((i) => ({
      id: i.id as string, name: i.name as string, brand: (i.brand as string | null) ?? null, category: i.category as StockItem['category'],
      hsn: i.hsn_code as string, baseUom: i.base_uom as string, altUom: (i.alt_uom as string | null) ?? null,
      factor: i.conversion_factor === null ? null : d4(i.conversion_factor), reorderLevel: d3(i.reorder_level),
    }));

  // Per item, per godown, for the modals' "on hand" hint; per item for the selected godown(s) for the table.
  const byItem = new Map<string, typeof sumRows>();
  for (const r of sumRows) byItem.set(r.item_id, [...(byItem.get(r.item_id) ?? []), r]);
  const onHandOf = (itemId: string): Record<string, string> =>
    Object.fromEntries((byItem.get(itemId) ?? []).map((r) => [r.warehouse_id, d3(r.qty)]));

  const needle = (opts.q ?? '').trim().toLowerCase();
  const tableRows: StockRow[] = [];
  for (const item of items) {
    if (needle && !`${item.name} ${item.brand ?? ''} ${item.hsn}`.toLowerCase().includes(needle)) continue;
    const own = (byItem.get(item.id) ?? []).filter((r) => selected === 'all' || r.warehouse_id === selected);
    const total = sumStock(own.map((r) => ({ qty: d3(r.qty), value: r.value === undefined ? undefined : d2(r.value) })));
    const avg = total.value === null ? null : averageRate(total.value, total.qty);
    const positive = signOf(total.qty) === 1;
    const low = positive && signOf(item.reorderLevel) === 1 && compareDecimal(total.qty, item.reorderLevel, 3) !== 1;
    const level: StockLevel = own.length === 0 ? 'none' : !positive ? 'out' : low ? 'low' : 'ok';
    tableRows.push({ item, qty: total.qty, avgRate: avg, value: total.value, level });
  }

  const allShown = sumStock(tableRows.map((r) => ({ qty: r.qty, value: r.value ?? undefined })));
  const cementRows = tableRows.filter((r) => r.item.category === 'cement');
  const steelRows = tableRows.filter((r) => r.item.category === 'steel');
  const uomOf = (rs: StockRow[]) => (rs.length && rs.every((r) => r.item.baseUom === rs[0]!.item.baseUom) ? rs[0]!.item.baseUom : null);
  const cementUom = uomOf(cementRows);
  const steelUom = uomOf(steelRows);
  const steelQty = sumStock(steelRows.map((r) => ({ qty: r.qty })));

  const transit = sumStock(inTransitRows.map((r) => ({ qty: d3(r.qty), value: r.value === undefined ? undefined : d2(r.value) })));

  const trHeads = rows(trRes, 'transfers in transit');
  const nameOf = new Map(godowns.map((g) => [g.id, g.name]));
  let transfers: TransferInTransit[] = [];
  if (trHeads.length) {
    const lineRes = await supabase
      .from('stock_transfer_lines')
      .select('transfer_id, line_no, item_name, uom, qty')
      .in('transfer_id', trHeads.map((h) => h.id as string))
      .order('line_no');
    const lines = rows(lineRes, 'transfer lines');
    transfers = trHeads.map((h) => ({
      id: h.id as string, transferNo: (h.transfer_no as string | null) ?? null, transferDate: h.transfer_date as string,
      fromName: nameOf.get(h.from_warehouse_id as string) ?? '', toName: nameOf.get(h.to_warehouse_id as string) ?? '',
      vehicleNo: (h.vehicle_no as string | null) ?? null,
      lines: lines.filter((l) => l.transfer_id === h.id).map((l) => ({ itemName: l.item_name as string, uom: l.uom as string, qty: d3(l.qty) })),
    }));
  }

  return {
    today: todayIn(orgRes.data?.timezone ?? 'Asia/Kolkata'),
    godowns, selected, rows: tableRows,
    tiles: {
      value: allShown.value,
      itemCount: tableRows.filter((r) => r.level !== 'none').length,
      cement: cementUom ? { qty: sumStock(cementRows.map((r) => ({ qty: r.qty }))).qty, uom: cementUom } : null,
      steel: steelUom ? { qty: steelQty.qty, uom: steelUom, tonnes: steelUom.toLowerCase() === 'kg' ? kgToTonnes(steelQty.qty) : null } : null,
      inTransit: { transfers: transfers.length, value: transit.value },
    },
    transfers,
    form: { items: items.filter((i) => i.baseUom).map((i) => ({ ...i, onHand: onHandOf(i.id) })) },
  };
}

export interface LedgerLine {
  key: string;
  date: string;
  docNo: string | null;
  sourceType: string;
  sourceId: string | null;
  isReversal: boolean;
  qty: string;
  runningQty: string;
  /** Owner-only from here down. */
  rate: string | null;
  value: string | null;
  runningValue: string | null;
}

export interface ItemLedger {
  item: StockItem;
  godowns: Godown[];
  warehouseId: string;
  period: { from: string; to: string } | null;
  broughtForward: { qty: string; value: string | null } | null;
  lines: LedgerLine[];
  closing: { qty: string; value: string | null };
  truncated: boolean;
}

const PAGE = 1000;
const MAX_PAGES = 20;

/** One item's movement ledger in one godown (`v_stock_ledger`). Cost columns are selected for owners only. */
export async function loadItemLedger(
  supabase: Supabase,
  itemId: string,
  opts: { warehouse: string | undefined; fy: { from: string; to: string } | null; isAdmin: boolean },
): Promise<ItemLedger | null> {
  const [itemRes, whRes] = await Promise.all([
    supabase.from('items').select('id, name, brand, category, hsn_code, base_uom, alt_uom, conversion_factor, reorder_level, is_stock').eq('id', itemId).maybeSingle(),
    supabase.from('warehouses').select('id, name, is_default').eq('is_transit', false).order('name'),
  ]);
  if (itemRes.error) throw new Error(`item: ${itemRes.error.message}`);
  const i = itemRes.data;
  if (!i || !i.is_stock) return null;
  const godowns: Godown[] = rows(whRes, 'godowns').map((w) => ({ id: w.id as string, name: w.name as string, isDefault: !!w.is_default }));
  const warehouseId = godowns.some((g) => g.id === opts.warehouse) ? (opts.warehouse as string) : (godowns.find((g) => g.isDefault)?.id ?? godowns[0]?.id);
  if (!warehouseId) return null;

  const cols = opts.isAdmin
    ? 'movement_id, movement_date, source_type, source_id, doc_no, is_reversal, qty, rate, value, running_qty, running_value'
    : 'movement_id, movement_date, source_type, source_id, doc_no, is_reversal, qty, running_qty';
  const base = () => supabase.from('v_stock_ledger').select(cols).eq('item_id', itemId).eq('warehouse_id', warehouseId);
  const order = <Q extends { order: (c: string, o: { ascending: boolean }) => Q }>(q: Q, asc: boolean): Q =>
    q.order('movement_date', { ascending: asc }).order('seq', { ascending: asc });

  type Raw = { movement_id: string; movement_date: string; source_type: string; source_id: string | null; doc_no: string | null; is_reversal: boolean; qty: number; rate?: number; value?: number; running_qty: number; running_value?: number };
  const map = (r: Raw): LedgerLine => ({
    key: r.movement_id, date: r.movement_date, docNo: r.doc_no ?? null, sourceType: r.source_type, sourceId: r.source_id ?? null,
    isReversal: !!r.is_reversal, qty: d3(r.qty), runningQty: d3(r.running_qty),
    rate: r.rate === undefined ? null : d4(r.rate), value: r.value === undefined ? null : d2(r.value),
    runningValue: r.running_value === undefined ? null : d2(r.running_value),
  });

  const lines: LedgerLine[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = order(base(), true);
    if (opts.fy) q = q.gte('movement_date', opts.fy.from).lte('movement_date', opts.fy.to);
    const { data, error } = await q.range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`stock ledger: ${error.message}`);
    lines.push(...((data ?? []) as unknown as Raw[]).map(map));
    if ((data?.length ?? 0) < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  let broughtForward: ItemLedger['broughtForward'] = null;
  if (opts.fy) {
    const { data, error } = await order(base().lt('movement_date', opts.fy.from), false).limit(1);
    if (error) throw new Error(`stock brought-forward: ${error.message}`);
    const r = ((data ?? []) as unknown as Raw[])[0];
    if (r) broughtForward = { qty: d3(r.running_qty), value: r.running_value === undefined ? null : d2(r.running_value) };
  }
  const last = lines[lines.length - 1];
  const closing = last ? { qty: last.runningQty, value: last.runningValue } : broughtForward ?? { qty: '0.000', value: opts.isAdmin ? '0.00' : null };

  return {
    item: {
      id: i.id as string, name: i.name as string, brand: (i.brand as string | null) ?? null, category: i.category as StockItem['category'],
      hsn: i.hsn_code as string, baseUom: i.base_uom as string, altUom: (i.alt_uom as string | null) ?? null,
      factor: i.conversion_factor === null ? null : d4(i.conversion_factor), reorderLevel: d3(i.reorder_level),
    },
    godowns, warehouseId, period: opts.fy, broughtForward, lines, closing, truncated,
  };
}
