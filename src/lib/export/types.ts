import type { createClient } from '@/lib/supabase/server';

// Shared shapes of the export layer (change 25). One description of a table of rows serves the Excel
// workbook (part A) and the JSON files of the year archive (part C); Tally (part B) reads the same
// paged readers. Nothing here knows about spreadsheets or JSON.

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * How a column's values travel and how a writer should show them.
 *   text      string
 *   int       number (a count, a line number, an entry number)
 *   money     decimal TEXT, 2 places ("1234567.89", may be negative)
 *   qty       decimal TEXT, 3 places
 *   rate      decimal TEXT, 4 places
 *   date      ISO date text "YYYY-MM-DD" (a business date, never shifted by a time zone)
 *   datetime  ISO instant text, as the database returns it
 *   bool      boolean
 */
export type ColumnType = 'text' | 'int' | 'money' | 'qty' | 'rate' | 'date' | 'datetime' | 'bool';

export interface ExportColumn {
  /** Machine key (snake_case): the JSON property name and the schema.json entry. */
  key: string;
  /** Human heading for a sheet. */
  header: string;
  type: ColumnType;
  /** Sheet column width in characters; a writer picks a default from the type. */
  width?: number;
}

/** A row is positional: one value per column, in column order. null = empty. */
export type ExportCell = string | number | boolean | null;
export type ExportRow = ExportCell[];

export interface ExportTable {
  /** Sheet name (max 31 characters, no []:*?/\) and the base of a JSON file name. */
  name: string;
  /** One plain sentence: what this table holds. Shown in the README. */
  description: string;
  columns: ExportColumn[];
  /** A fresh, lazy, ordered pass over the rows. Each call reads again; callers use it once. */
  rows(): AsyncIterable<ExportRow>;
  /**
   * How many rows `rows()` will yield when that is known cheaply beforehand (a head count from the
   * database). Used for the row cap and the README; absent for tables derived in memory.
   */
  expectedRows?: () => Promise<number | null>;
  /** Extra rows a sheet shows after the data (totals, a balance check). JSON writers ignore them. */
  footer?: () => ExportRow[] | Promise<ExportRow[]>;
}

/** The fixed facts of one export run, captured once at the start. */
export interface ExportContext {
  /** The signed-in owner's user-scoped client: row-level security applies; never the service key. */
  supabase: Supabase;
  /** Every table is read as it stood at this instant (rows created later are left out). ISO instant. */
  asOf: string;
  fy: FiscalYear;
  timeZone: string;
  orgName: string;
  /** Display name of the person exporting. */
  generatedBy: string;
}

export interface FiscalYear {
  /** Calendar year the FY starts in: 2026 = April 2026 to March 2027. */
  startYear: number;
  /** First and last day, ISO. */
  from: string;
  to: string;
  /** '2026-27' */
  label: string;
}

/** A sheet or file passed the row cap. The route turns it into HTTP 422. */
export class RowCapError extends Error {
  constructor(public readonly table: string, public readonly cap: number) {
    super(`row_cap:${table}:${cap}`);
    this.name = 'RowCapError';
  }
}

/** The most rows one sheet / JSON file may hold. */
export const EXPORT_ROW_CAP = 200_000;

/** Rows per database request (PostgREST's own cap is 1,000, set in supabase/config.toml). */
export const PAGE_SIZE = 1000;
