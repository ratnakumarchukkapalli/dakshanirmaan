import { PAGE_SIZE, type ExportContext, type Supabase } from './types';

// Paged readers. A table or view is read through the owner's own client in pages of 1,000 (the API's
// own limit), in a fixed order, filtered to the financial year and to rows that existed at `asOf`.
// Offsets are safe because of that order and the `created_at <= asOf` filter: posted rows never
// change, and rows created while the export runs are left out. A failed page throws; nothing is
// ever skipped or truncated silently.

/** The filter/order surface of a PostgREST query that the readers use (the real builder is wider). */
export interface Query extends PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }> {
  lte(column: string, value: string | number): Query;
  gte(column: string, value: string | number): Query;
  gt(column: string, value: string | number): Query;
  eq(column: string, value: string | number | boolean): Query;
  neq(column: string, value: string | number | boolean): Query;
  not(column: string, operator: string, value: unknown): Query;
  in(column: string, values: readonly (string | number)[]): Query;
  order(column: string, options?: { ascending?: boolean }): Query;
  range(from: number, to: number): Query;
}

export interface PagedSpec {
  /** Table or view. */
  from: string;
  /**
   * The select list. NUMERIC columns are cast to text (`debit::text`) so the digits arrive exactly as
   * the database holds them; to-many embeds (`journal_lines(...)`) and `!inner` embeds are fine.
   */
  select: string;
  /** Stable order: the first column that gives a total order wins ties after the others. Always end with a unique key. */
  order: string[];
  /** The table's own business-date column and the inclusive range to read. */
  dateColumn?: string;
  range?: { from?: string; to?: string };
  /** Column that must be <= asOf. Default 'created_at'; `false` for a view that has none. */
  createdAt?: string | false;
  /** Anything else: status filters, embedded-table filters (`journal_entries.entry_date`). */
  filter?: (q: Query) => Query;
}

type Reader = Pick<ExportContext, 'supabase' | 'asOf'>;

function constrain(q: Query, spec: PagedSpec, asOf: string): Query {
  let out = q;
  if (spec.dateColumn && spec.range?.from) out = out.gte(spec.dateColumn, spec.range.from);
  if (spec.dateColumn && spec.range?.to) out = out.lte(spec.dateColumn, spec.range.to);
  const created = spec.createdAt === undefined ? 'created_at' : spec.createdAt;
  if (created) out = out.lte(created, asOf);
  return spec.filter ? spec.filter(out) : out;
}

const fail = (what: string, error: { message: string }): never => {
  throw new Error(`export ${what}: ${error.message}`);
};

function pageRows<T>(what: string, res: { data: unknown; error: { message: string } | null }): T[] {
  if (res.error) return fail(what, res.error);
  return (res.data ?? []) as T[];
}

/**
 * A read that came back shorter (or longer) than the database said it would. The usual cause is an API
 * row limit below a page; nothing downstream may treat such a read as the whole table.
 */
export class ShortReadError extends Error {
  constructor(what: string, public readonly got: number, public readonly expected: number) {
    super(`export ${what}: read ${got} rows but the database counted ${expected}`);
    this.name = 'ShortReadError';
  }
}

/**
 * Every row of the spec, one page (1,000 rows) at a time. The first page also asks for the exact count;
 * when the rows yielded do not add up to it the read throws, so no caller (a sheet, an aggregate, a
 * lookup) can mistake a truncated read for the whole table.
 */
export async function* readPaged<T = Record<string, unknown>>(ctx: Reader, spec: PagedSpec): AsyncGenerator<T> {
  let total = -1;
  let yielded = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let q = ctx.supabase.from(spec.from).select(spec.select, offset === 0 ? { count: 'exact' } : undefined) as unknown as Query;
    q = constrain(q, spec, ctx.asOf);
    for (const col of spec.order) q = q.order(col, { ascending: true });
    const res = await q.range(offset, offset + PAGE_SIZE - 1);
    const page = pageRows<T>(spec.from, res);
    if (offset === 0) {
      if (typeof res.count !== 'number') throw new Error(`export ${spec.from}: the database gave no count`);
      total = res.count;
    }
    yielded += page.length;
    yield* page;
    if (page.length < PAGE_SIZE) return verify(spec, yielded, total);
  }
}

// A view without created_at can gain a row while the read runs; that is not a short read.
function verify(spec: PagedSpec, yielded: number, total: number): void {
  if (yielded < total || (yielded > total && spec.createdAt !== false)) throw new ShortReadError(spec.from, yielded, total);
}

/** Exact row count with the same filters as `readPaged` (a head request: no rows travel). */
export async function countRows(ctx: Reader, spec: PagedSpec): Promise<number> {
  let q = ctx.supabase.from(spec.from).select(spec.select, { count: 'exact', head: true }) as unknown as Query;
  q = constrain(q, spec, ctx.asOf);
  const res = await q;
  if (res.error) return fail(`${spec.from} count`, res.error);
  if (typeof res.count !== 'number') throw new Error(`export ${spec.from} count: the database gave no count`);
  return res.count;
}

/** A set-returning database function read the same way (e.g. `stock_movement_cost`), with the same count check. */
export async function* readRpcPaged<T = Record<string, unknown>>(
  supabase: Supabase, fn: string, select: string, order: string[],
): AsyncGenerator<T> {
  let total = -1;
  let yielded = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let q = supabase.rpc(fn, undefined, offset === 0 ? { count: 'exact' } : undefined).select(select) as unknown as Query;
    for (const col of order) q = q.order(col, { ascending: true });
    const res = await q.range(offset, offset + PAGE_SIZE - 1);
    const page = pageRows<T>(fn, res);
    if (offset === 0) {
      if (typeof res.count !== 'number') throw new Error(`export ${fn}: the database gave no count`);
      total = res.count;
    }
    yielded += page.length;
    yield* page;
    if (page.length < PAGE_SIZE) {
      if (yielded !== total) throw new ShortReadError(fn, yielded, total);
      return;
    }
  }
}

/** Drains a generator into an array — for small master tables only (accounts, parties, items). */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
