'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { signOut } from '@/app/actions/auth';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { isActive } from '@/lib/nav';

interface Props {
  initial: string;
  name: string;
  roleLabel: string;
  label: string;
  signOutLabel: string;
  /** Screens that are only in the menu on phones (the rail is hidden there). */
  items: { href: string; label: string }[];
}

export function AvatarMenu({ initial, name, roleLabel, label, signOutLabel, items }: Props) {
  const pathname = usePathname();
  // Remember which page the menu was opened on: navigating elsewhere closes it without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenOn(null);
        button.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpenOn(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button
        ref={button}
        type="button"
        className="avatar"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={`${name} · ${roleLabel}`}
        onClick={() => setOpenOn(open ? null : pathname)}
      >
        {initial}
      </button>
      {open && (
        <GlassPanel strong id={menuId} className="menu">
          <div className="who">
            <b>{name}</b>
            <span>{roleLabel}</span>
          </div>
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="only-mobile"
              aria-current={isActive(pathname, item.href) ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
          <form action={signOut}>
            <button type="submit" className="menubtn">
              {signOutLabel}
            </button>
          </form>
        </GlassPanel>
      )}
    </div>
  );
}
