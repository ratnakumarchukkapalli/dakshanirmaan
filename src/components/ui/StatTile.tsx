import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Colours the figure (ageing: older buckets warn). The label and figure always carry the meaning, never colour alone. */
  tone?: 'good' | 'warn' | 'bad';
  /** Smaller figure, for a row of four or more tiles. */
  small?: boolean;
  /** The one headline tile of a row (dashboard: today's sales): accent gradient. */
  hero?: boolean;
  /** Colours the sub line (overdue = bad). The text always says what it means. */
  subTone?: 'good' | 'warn' | 'bad';
}

/** A single summary number in a `.tiles` row (payments list, ageing, stock and staff tiles). */
export function StatTile({ label, value, sub, tone, small, hero, subTone }: Props) {
  return (
    <div className={hero ? 'tile hero' : 'tile'}>
      <div className="lbl">{label}</div>
      <div className={['val num', tone, small ? 'small' : ''].filter(Boolean).join(' ')}>{value}</div>
      {sub !== undefined && sub !== null && <div className={['sub', subTone].filter(Boolean).join(' ')}>{sub}</div>}
    </div>
  );
}
