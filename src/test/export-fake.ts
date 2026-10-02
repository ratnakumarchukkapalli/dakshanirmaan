// A small in-memory stand-in for the Supabase client, enough for the export layer's tests: tables are
// arrays of rows already in PostgREST's shape (embedded rows nested), and the query builder applies the
// filters, order and range the readers use, counts head requests, and records every request.
//
//   const db = fakeDb({ parties: [...] });
//   const supabase = fakeSupabase(db);

type Row = Record<string, unknown>;

export interface FakeRequest {
  kind: 'table' | 'rpc';
  name: string;
  select?: string;
  head?: boolean;
  filters: string[];
  order: string[];
  range?: [number, number];
}

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** RPC name -> function from args to rows (or an Error to fail with). */
  rpcs: Record<string, (args: Record<string, unknown> | undefined) => Row[] | Row | Error>;
  /** Head-count overrides per table (to test the row cap without 200,000 fixture rows). */
  counts: Record<string, number>;
  /** Tables / rpcs that fail with this message. */
  errors: Record<string, string>;
  /** Fail row reads of this table but not head counts (a failure after the export has started). */
  readErrors: Record<string, string>;
  /** Most rows any one request returns, whatever the range asked (an API row limit below the page size). */
  maxRows?: number;
  requests: FakeRequest[];
}

export function fakeDb(tables: Record<string, Row[]> = {}): FakeDb {
  return { tables, rpcs: {}, counts: {}, errors: {}, readErrors: {}, requests: [] };
}

const at = (row: Row, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Row)[k] : undefined), row);

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : 1;
}

class Query implements PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }> {
  private preds: ((r: Row) => boolean)[] = [];
  private orders: string[] = [];
  private rangeArg?: [number, number];
  private head = false;
  private countExact = false;
  private single = false;
  private selectText?: string;
  private request: FakeRequest;

  constructor(private db: FakeDb, private kind: 'table' | 'rpc', private name: string, private args?: Record<string, unknown>, countMode?: string) {
    this.countExact = countMode === 'exact';
    this.request = { kind, name, filters: [], order: [] };
    db.requests.push(this.request);
  }

  select(text: string, options?: { count?: string; head?: boolean }) {
    this.selectText = text;
    this.request.select = text;
    if (options?.count === 'exact') this.countExact = true;
    if (options?.head) { this.head = true; this.request.head = true; }
    return this;
  }
  private add(label: string, pred: (r: Row) => boolean) { this.request.filters.push(label); this.preds.push(pred); return this; }
  // A row without the column passes created_at <= x, so fixtures can leave it out.
  lte(c: string, v: string | number) { return this.add(`${c}<=${v}`, (r) => { const x = at(r, c); return x === undefined || compare(x, v) <= 0; }); }
  gte(c: string, v: string | number) { return this.add(`${c}>=${v}`, (r) => compare(at(r, c), v) >= 0); }
  gt(c: string, v: string | number) { return this.add(`${c}>${v}`, (r) => { const x = at(r, c); return x !== undefined && compare(x, v) > 0; }); }
  eq(c: string, v: unknown) { return this.add(`${c}=${String(v)}`, (r) => at(r, c) === v); }
  neq(c: string, v: unknown) { return this.add(`${c}!=${String(v)}`, (r) => at(r, c) !== v); }
  not(c: string, op: string, v: unknown) { return this.add(`not.${c}.${op}.${String(v)}`, (r) => (op === 'is' && v === null ? at(r, c) !== null && at(r, c) !== undefined : at(r, c) !== v)); }
  in(c: string, vs: unknown[]) { return this.add(`${c} in`, (r) => vs.includes(at(r, c))); }
  order(c: string) { this.orders.push(c); this.request.order.push(c); return this; }
  maybeSingle() { this.single = true; return this; }
  range(a: number, b: number) { this.rangeArg = [a, b]; this.request.range = [a, b]; return this; }

  private run(): { data: unknown; error: { message: string } | null; count?: number | null } {
    const failure = this.db.errors[this.name];
    if (failure) return { data: null, error: { message: failure } };
    const readFailure = this.db.readErrors[this.name];
    if (readFailure && !this.head) return { data: null, error: { message: readFailure } };
    let rows: Row[];
    if (this.kind === 'rpc') {
      const fn = this.db.rpcs[this.name];
      if (!fn) return { data: null, error: { message: `no such function ${this.name}` } };
      const out = fn(this.args);
      if (out instanceof Error) return { data: null, error: { message: out.message } };
      if (!Array.isArray(out)) return { data: out, error: null };
      rows = out;
    } else {
      const table = this.db.tables[this.name];
      if (!table) return { data: null, error: { message: `no such table ${this.name}` } };
      rows = table;
    }
    rows = rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.head) return { data: null, error: null, count: this.db.counts[this.name] ?? rows.length };
    // order keys look like "col" or "embed(col)"
    const keys = this.orders.map((o) => o.replace(/^(\w+)\((\w+)\)$/, '$1.$2'));
    if (keys.length) rows = [...rows].sort((x, y) => { for (const k of keys) { const d = compare(at(x, k), at(y, k)); if (d !== 0) return d; } return 0; });
    const total = rows.length;
    if (this.rangeArg) rows = rows.slice(this.rangeArg[0], this.rangeArg[1] + 1);
    if (this.db.maxRows !== undefined) rows = rows.slice(0, this.db.maxRows);
    return { data: this.single ? (rows[0] ?? null) : rows, error: null, ...(this.countExact ? { count: total } : {}) };
  }

  then<R1 = unknown, R2 = never>(
    onfulfilled?: ((v: { data: unknown; error: { message: string } | null; count?: number | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

export function fakeSupabase(db: FakeDb) {
  return {
    from: (table: string) => new Query(db, 'table', table),
    rpc: (fn: string, args?: Record<string, unknown>, options?: { count?: string }) => new Query(db, 'rpc', fn, args, options?.count),
  };
}
