'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { isActive } from '@/lib/nav';

/** Link that marks itself as the current page (styled via aria-current). */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <Link href={href} aria-current={isActive(pathname, href) ? 'page' : undefined}>
      {children}
    </Link>
  );
}
