export type NavKey =
  | 'dashboard' | 'sales' | 'purchases' | 'payments' | 'parties' | 'stock' | 'staff' | 'reports' | 'settings';

export const NAV_HREF: Record<NavKey, string> = {
  dashboard: '/',
  sales: '/sales',
  purchases: '/purchases',
  payments: '/payments',
  parties: '/parties',
  stock: '/stock',
  staff: '/staff',
  reports: '/reports',
  settings: '/settings',
};

/** Side rail, in order; a separator sits before the last group. */
export const RAIL_MAIN: NavKey[] = ['dashboard', 'sales', 'purchases', 'payments', 'parties', 'stock', 'staff'];
export const RAIL_ADMIN: NavKey[] = ['reports', 'settings'];

/** Bottom tab bar (≤800px): Home, Sales, Parties, Stock, Money (= Payments). */
export const TABS: { key: NavKey; label: 'home' | 'sales' | 'parties' | 'stock' | 'money' }[] = [
  { key: 'dashboard', label: 'home' },
  { key: 'sales', label: 'sales' },
  { key: 'parties', label: 'parties' },
  { key: 'stock', label: 'stock' },
  { key: 'payments', label: 'money' },
];

/** Reached from the avatar menu on phones. */
export const MENU_EXTRAS: NavKey[] = ['purchases', 'staff', 'reports', 'settings'];

export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/** Screens a counter (`user`) role never sees; the proxy also turns them away (settings; staff = salaries, owner-only). */
const ADMIN_ONLY: NavKey[] = ['settings', 'staff'];

export function visibleFor(role: 'admin' | 'user', keys: NavKey[]): NavKey[] {
  return role === 'admin' ? keys : keys.filter((k) => !ADMIN_ONLY.includes(k));
}
