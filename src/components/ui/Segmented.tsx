import Link from 'next/link';
import { GlassPanel } from './GlassPanel';

interface Option {
  key: string;
  label: string;
  href: string;
}

/** Filter tabs that live in the URL (`?type=`), so lists stay server-rendered and shareable. */
export function Segmented({ options, active, label }: { options: Option[]; active: string; label: string }) {
  return (
    <GlassPanel as="nav" className="seg" aria-label={label}>
      {options.map((o) => (
        <Link key={o.key} href={o.href} aria-current={o.key === active ? 'true' : undefined}>
          {o.label}
        </Link>
      ))}
    </GlassPanel>
  );
}
