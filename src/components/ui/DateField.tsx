'use client';

import { useState } from 'react';
import { formatDate } from '@/lib/format';

interface Props {
  id: string;
  /** ISO date (YYYY-MM-DD) or ''. */
  value: string;
  onChange: (iso: string) => void;
  placeholder: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

/** DD-MM-YYYY text → ISO, or '' when it is not a real date. */
export function parseDisplayDate(text: string): string {
  const m = /^\s*(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})\s*$/.exec(text);
  if (!m) return '';
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * A date typed as DD-MM-YYYY (the display format everywhere in the app). The form holds the ISO
 * value; a half-typed or impossible date holds '' so the schema reports it.
 */
export function DateField({ id, value, onChange, placeholder, ...aria }: Props) {
  const [text, setText] = useState(value ? formatDate(value) : '');
  // Show a value set from outside (the "Today" button) without an effect: track the last ISO we produced.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value) setText(formatDate(value));
  }
  return (
    <input
      id={id} className="num" inputMode="numeric" autoComplete="off" placeholder={placeholder} value={text}
      onChange={(e) => {
        setText(e.target.value);
        const iso = parseDisplayDate(e.target.value);
        setSeen(iso);
        onChange(iso);
      }}
      {...aria}
    />
  );
}
