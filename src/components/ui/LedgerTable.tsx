import type { ReactNode } from 'react';
import { RowLink } from '@/components/sales/RowLink';

export interface LedgerColumn {
  header: string;
  /** Numeric columns are right-aligned, tabular and never wrap. */
  numeric?: boolean;
  /** Dates and document numbers never wrap. */
  nowrap?: boolean;
}

export interface LedgerTableRow {
  key: string;
  cells: ReactNode[];
  /** When set the whole row is keyboard-activatable (Enter) and opens this. */
  href?: string | null;
  /** Styles a "balance brought forward" line. */
  variant?: 'bf';
}

interface Props {
  columns: LedgerColumn[];
  rows: LedgerTableRow[];
  /** A closing line (cells align with the columns). */
  footer?: ReactNode[];
}

/**
 * The shared ledger shape for party, stock and staff ledgers (and their lists): a solid table
 * inside a horizontally-scrolling card, numbers right-aligned and tabular. A row with an `href` is
 * focusable and opens on Enter (and click); the document cell should also carry a real link.
 */
export function LedgerTable({ columns, rows, footer }: Props) {
  const cell = (c: LedgerColumn, node: ReactNode, i: number) => (
    <td key={i} className={c.numeric ? 'r num' : c.nowrap ? 'nowrap' : 'wide'}>{node}</td>
  );
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} className={c.numeric ? 'r' : undefined}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const cells = r.cells.map((n, i) => cell(columns[i]!, n, i));
            if (r.href) return <RowLink key={r.key} href={r.href}>{cells}</RowLink>;
            return <tr key={r.key} className={r.variant === 'bf' ? 'bf' : undefined}>{cells}</tr>;
          })}
        </tbody>
        {footer && (
          <tfoot>
            <tr className="ledgerfoot">
              {footer.map((n, i) => cell(columns[i]!, n, i))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
