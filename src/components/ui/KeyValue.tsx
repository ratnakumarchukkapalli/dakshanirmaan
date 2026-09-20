import type { ReactNode } from 'react';

/** Label / value pairs (a definition list). */
export function KeyValue({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="kv">
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'contents' }}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
