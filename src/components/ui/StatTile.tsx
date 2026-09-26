import Link from 'next/link';
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
  /** Makes the whole tile a link to the screen behind the figure. */
  href?: string;
}

/** A single summary number in a `.tiles` row (payments list, ageing, stock and staff tiles). */
export function StatTile({ label, value, sub, tone, small, hero, subTone, href }: Props) {
  const className = ['tile', hero ? 'hero' : '', href ? 'tile-link' : ''].filter(Boolean).join(' ');
  const body = (
    <>
      <div className="lbl">{label}</div>
      <div className={['val num', tone, small ? 'small' : ''].filter(Boolean).join(' ')}>{value}</div>
      {sub !== undefined && sub !== null && <div className={['sub', subTone].filter(Boolean).join(' ')}>{sub}</div>}
    </>
  );
  return href ? <Link href={href} className={className}>{body}</Link> : <div className={className}>{body}</div>;
}
