'use client';

import { useState } from 'react';
import { DateField } from '@/components/ui/DateField';

interface Props {
  /** Date filters: each is submitted as an ISO value under `name`. */
  dates: { name: string; label: string; value: string }[];
  /** Optional single choice (day book: entry type). */
  select?: { name: string; label: string; value: string; options: { value: string; label: string }[] };
  /** Other URL state kept as-is (a selected account, a godown…). */
  keep?: Record<string, string | undefined>;
  datePlaceholder: string;
  submitLabel: string;
}

/**
 * A GET form for report filters: dates are typed as DD-MM-YYYY (the app-wide display format) and go
 * to the URL as ISO, so every filtered report is a shareable, server-rendered link. An impossible
 * date is submitted empty and the page falls back to its default range.
 */
export function ReportFilters({ dates, select, keep = {}, datePlaceholder, submitLabel }: Props) {
  const [values, setValues] = useState(() => Object.fromEntries(dates.map((d) => [d.name, d.value])));
  return (
    <form method="get" className="filters">
      {Object.entries(keep).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
      {dates.map((d) => (
        <div key={d.name} className="field datefield">
          <label htmlFor={`f-${d.name}`}>{d.label}</label>
          <DateField id={`f-${d.name}`} value={values[d.name] ?? ''} onChange={(iso) => setValues((v) => ({ ...v, [d.name]: iso }))} placeholder={datePlaceholder} />
          <input type="hidden" name={d.name} value={values[d.name] ?? ''} />
        </div>
      ))}
      {select && (
        <div className="field">
          <label htmlFor={`f-${select.name}`}>{select.label}</label>
          <select id={`f-${select.name}`} name={select.name} defaultValue={select.value}>
            {select.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
      <button type="submit" className="btn ghost">{submitLabel}</button>
    </form>
  );
}
