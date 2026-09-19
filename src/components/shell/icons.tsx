import type { NavKey } from '@/lib/nav';

// Paths copied from prototype/daksh-nirmaan.html (16×16, filled).
const PATHS: Record<NavKey, string> = {
  dashboard: 'M1 8.5 8 2l7 6.5h-2V14H9.5v-3.5h-3V14H3V8.5H1z',
  sales: 'M3 1h10v14l-2-1.2L9 15l-2-1.2L5 15l-2-1.2V1zm2 4h6v1.3H5V5zm0 3h6v1.3H5V8z',
  purchases: 'M2 3h2l1.6 7.5h6.9L14 5H5.2M6 14a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm6 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  payments: 'M1 4h14v9H1zM1 6.5h14V8H1zM3 10h4v1.3H3z',
  parties: 'M6 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-5 6c0-2.8 2.2-5 5-5s5 2.2 5 5H1zm10.5-6.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM12 14c0-1.7-.6-3.2-1.6-4.4.5-.2 1-.3 1.6-.3 2.2 0 4 1.8 4 4h-4z',
  stock: 'M8 1 15 4.5v7L8 15 1 11.5v-7L8 1zm0 1.6L3 5l5 2.4L13 5 8 2.6zM2.4 6.3v4.6L7.4 13.4V8.8L2.4 6.3zm11.2 0L8.6 8.8v4.6l5-2.5V6.3z',
  staff: 'M8 7.2A2.6 2.6 0 1 0 8 2a2.6 2.6 0 0 0 0 5.2zM3 14c0-2.8 2.2-5 5-5s5 2.2 5 5H3z',
  reports: 'M2 13h12v1.5H2zM3 8h2v4H3zm4-4h2v8H7zm4 2h2v6h-2z',
  settings: 'M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm-1.5-4h3l.4 1.9 1.7 1 1.8-.6 1.5 2.6-1.4 1.3v2l1.4 1.3-1.5 2.6-1.8-.6-1.7 1-.4 1.9h-3l-.4-1.9-1.7-1-1.8.6L1.1 10.5l1.4-1.3v-2L1.1 5.9l1.5-2.6 1.8.6 1.7-1z',
};

export function NavIcon({ name, size = 17 }: { name: NavKey; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Crane mark from the prototype, on the amber tile. */
export function BrandMark() {
  return (
    <div className="brandmark" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 21h10M8 21V5M8 5h13M8 5V2l13 3M17 5v5" />
        <path d="M15.2 10h3.6v3h-3.6z" fill="currentColor" stroke="none" />
      </svg>
    </div>
  );
}
