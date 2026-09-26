// Small guard for server-side reads: a failed query must fail loudly, never render as "no rows".
// (A silent `data ?? []` is how a wrong column or an ambiguous embed once shipped as an empty screen.)

// The Supabase client here is untyped, so a row is a bag of columns; each caller reads the ones it selected.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Returns the rows of a PostgREST response, throwing (with the query's name) when it errored. */
export function rows<T = Row>(res: { data: unknown; error: { message: string } | null }, what: string): T[] {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return (res.data ?? []) as T[];
}

/** The single row (or null) of a `.maybeSingle()` response, throwing when it errored. */
export function one<T = Row>(res: { data: unknown; error: { message: string } | null }, what: string): T | null {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return (res.data ?? null) as T | null;
}

/**
 * Rows of a response made with `{ count: 'exact' }`, throwing when the server cut the list short
 * (PostgREST caps a response at `max_rows`). A total built from a truncated list would be wrong
 * without looking wrong, so it must fail instead.
 */
export function completeRows<T = Row>(res: { data: unknown; error: { message: string } | null; count?: number | null }, what: string): T[] {
  const list = rows<T>(res, what);
  if (typeof res.count === 'number' && res.count > list.length) {
    throw new Error(`${what}: ${res.count} rows exist but only ${list.length} were returned`);
  }
  return list;
}
