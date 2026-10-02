import { countRows, readPaged, type PagedSpec } from './paged';
import type { ColumnType, ExportColumn, ExportContext, ExportRow, ExportTable } from './types';

/** `col('invoice_no', 'Invoice no', 'text', 16)` */
export const col = (key: string, header: string, type: ColumnType, width?: number): ExportColumn => ({ key, header, type, ...(width ? { width } : {}) });

type Reader = Pick<ExportContext, 'supabase' | 'asOf'>;

export interface QueryTableDef<R> {
  name: string;
  description: string;
  columns: ExportColumn[];
  /** What to read, in what order. */
  spec: PagedSpec;
  /** Head-count spec when the rows written differ from the rows read (a line sheet driven by its lines); defaults to `spec`. */
  count?: PagedSpec;
  /** One database row -> the sheet rows it becomes (usually one; a voucher with lines may be several). */
  map: (row: R) => ExportRow[] | Promise<ExportRow[]>;
  /** Rows shown after the data in a sheet (totals); ignored by JSON writers. */
  footer?: ExportTable['footer'];
}

/** A table whose rows come straight from a paged database read. */
export function queryTable<R>(ctx: Reader, def: QueryTableDef<R>): ExportTable {
  return {
    name: def.name,
    description: def.description,
    columns: def.columns,
    async *rows() {
      for await (const r of readPaged<R>(ctx, def.spec)) yield* await def.map(r);
    },
    expectedRows: () => countRows(ctx, def.count ?? def.spec),
    ...(def.footer ? { footer: def.footer } : {}),
  };
}

/** A table whose rows are computed in memory (aggregates, pre-fetched RPC results). */
export function memoryTable(def: { name: string; description: string; columns: ExportColumn[]; rows: () => AsyncIterable<ExportRow> | Promise<ExportRow[]>; expected?: () => Promise<number | null>; footer?: ExportTable['footer'] }): ExportTable {
  return {
    name: def.name,
    description: def.description,
    columns: def.columns,
    async *rows() {
      const source = def.rows();
      if (Symbol.asyncIterator in (source as object)) yield* source as AsyncIterable<ExportRow>;
      else yield* await (source as Promise<ExportRow[]>);
    },
    ...(def.expected ? { expectedRows: def.expected } : {}),
    ...(def.footer ? { footer: def.footer } : {}),
  };
}

/** Turns a table's positional rows into keyed objects (for the JSON files of the archive). */
export async function* rowObjects(table: ExportTable): AsyncGenerator<Record<string, ExportRow[number]>> {
  for await (const row of table.rows()) {
    yield Object.fromEntries(table.columns.map((c, i) => [c.key, row[i] ?? null]));
  }
}
