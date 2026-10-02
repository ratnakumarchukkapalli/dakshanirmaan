// Text that goes into a spreadsheet cell. Shared by every Excel builder (full-books export, report workbooks,
// party statements) so a name typed at the counter cannot corrupt a file or run as a formula.

// Characters XML 1.0 cannot carry (control characters other than tab/newline/return, and the two
// non-characters). A name pasted from somewhere odd must not make the whole file unreadable.
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const FORMULA_START = /^[=+\-@\t\r]/;

/** The text with the characters an XLSX file cannot hold removed (for metadata that is not a cell). */
export const stripXmlIllegal = (value: string): string => value.replace(XML_ILLEGAL, '');

/**
 * Text for a cell: illegal XML characters removed, and a leading `=`, `+`, `-`, `@`, tab or carriage
 * return defused by a leading apostrophe, so a party called `=HYPERLINK("http://x","y")` shows as
 * that text in any spreadsheet and survives a CSV round trip. (Cells are written as strings, which
 * Excel never evaluates; the apostrophe protects what happens after a copy, a CSV save or an import.)
 */
export function safeText(value: string): string {
  const clean = stripXmlIllegal(value);
  return FORMULA_START.test(clean) ? `'${clean}` : clean;
}

/** A row of cell values with every text cell passed through `safeText`; numbers, dates and blanks are untouched. */
export function safeCells<T>(cells: readonly T[]): T[] {
  return cells.map((c) => (typeof c === 'string' ? (safeText(c) as unknown as T) : c));
}
