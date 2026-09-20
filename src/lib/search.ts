// Turns text typed in a search box into a PostgREST `.or()` filter without letting the text
// change the filter's structure. Two layers of escaping are needed, applied in this order:
//   1. LIKE: `%`, `_` and `\` are wildcards/escape in a pattern, so they get a backslash.
//      (PostgREST rewrites `*` to `%` inside like/ilike values and offers no way to escape it,
//      so a typed `*` becomes `_`, which matches any one character, including a literal `*`.)
//   2. PostgREST: the value goes inside double quotes, where only `\` and `"` are special
//      (`\\` and `\"`), which makes `,` `.` `:` `(` `)` plain characters. postgrest-js then
//      URL-encodes the whole filter, so `&` and `#` cannot leave the parameter either.

export const SEARCH_MAX_LENGTH = 60;

/** The search text as typed, minus control characters, trimmed and capped. */
export function cleanSearchText(raw: string | undefined | null, max = SEARCH_MAX_LENGTH): string {
  return (raw ?? '').replace(/\p{Cc}/gu, ' ').trim().slice(0, max).trim();
}

/** A LIKE pattern that matches the text anywhere inside a value, with PostgREST's `*` wildcards. */
export function containsPattern(text: string): string {
  const like = text.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '_');
  return `*${like}*`;
}

/** Wraps a value in double quotes for a PostgREST filter, escaping `\` and `"`. */
export function quoteFilterValue(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * `col.ilike."*text*",col2.ilike."*text*"` for `.or(...)`, or null when there is nothing to search.
 * `columns` are fixed names from our own code, never user input.
 */
export function orContainsFilter(columns: readonly string[], raw: string | undefined | null): string | null {
  const text = cleanSearchText(raw);
  if (!text) return null;
  const value = quoteFilterValue(containsPattern(text));
  return columns.map((c) => `${c}.ilike.${value}`).join(',');
}
