'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/** Picks the financial year for the three downloads; the choice lives in the URL (`?fy=2026`). */
export function ExportYearSelect({ id, label, years, value }: { id: string; label: string; years: { value: number; label: string }[]; value: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="field" style={{ maxWidth: 260 }}>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={pending} onChange={(e) => start(() => router.replace(`/settings/export?fy=${e.target.value}`))}>
        {years.map((y) => <option key={y.value} value={y.value}>{y.label}</option>)}
      </select>
    </div>
  );
}
