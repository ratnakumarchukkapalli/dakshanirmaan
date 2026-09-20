'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * A table row that opens its record on click or Enter. The number cell also holds a real link, so
 * middle-click / open-in-new-tab and screen readers keep working.
 */
export function RowLink({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <tr
      className="rowlink"
      tabIndex={0}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        router.push(href);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) router.push(href);
      }}
    >
      {children}
    </tr>
  );
}
