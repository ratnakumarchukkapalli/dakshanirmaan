import type { ReactNode } from 'react';

export type ChipTone = 'good' | 'warn' | 'bad' | 'muted' | 'accent';

/** Status pill. Always carries text: colour is never the only signal. */
export function Chip({ tone = 'muted', children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}
