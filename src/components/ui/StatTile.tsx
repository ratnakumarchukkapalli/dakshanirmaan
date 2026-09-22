import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}

/** A single summary number in a `.tiles` row (payments list, and later ageing/dashboard tiles). */
export function StatTile({ label, value, sub }: Props) {
  return (
    <div className="tile">
      <div className="lbl">{label}</div>
      <div className="val num">{value}</div>
      {sub !== undefined && sub !== null && <div className="sub">{sub}</div>}
    </div>
  );
}
