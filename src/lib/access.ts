// Who may see what, decided before any page renders. Pure so it can be unit-tested;
// src/proxy.ts feeds it the session facts.

export type AccessDecision =
  | { action: 'allow' }
  | { action: 'redirect'; to: '/login' | '/login/mfa' | '/' };

/** null = not signed in, not an active member, or session too old. */
export type Member = { role: 'admin' | 'user'; aal: 'aal1' | 'aal2' } | null;

const PUBLIC_PREFIXES = ['/api/manifest.webmanifest', '/sw.js', '/offline.html', '/icons/'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

// The one public API shape: an invoice PDF opened from a signed WhatsApp link. The route handler
// checks the signature itself; this only lets the request past the sign-in gate, and only when
// a signature is present.
const INVOICE_PDF_PATH = /^\/api\/invoices\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/pdf$/i;
export const isSignedInvoiceLink = (pathname: string, search: string): boolean =>
  INVOICE_PDF_PATH.test(pathname) && new URLSearchParams(search).has('sig');

const isLoginPath = (p: string) => p === '/login' || p.startsWith('/login/');
const isSettingsPath = (p: string) => p === '/settings' || p.startsWith('/settings/');
// Salaries and wages are owner-only (owner decision): the staff screens are not for a counter session.
const isStaffPath = (p: string) => p === '/staff' || p.startsWith('/staff/');
// Supplier bills are owner-only: the database lets only an owner post or cancel a purchase, and
// supplier rates and input tax are not counter data.
const isPurchasesPath = (p: string) => p === '/purchases' || p.startsWith('/purchases/');
// The cash & bank book is owner-only (bank balances and payroll cash are not counter data). Only the
// screen is turned away here; its Excel route answers 403 itself, so a download never redirects.
const isCashBookPath = (p: string) => p === '/reports/cash-bank' || p.startsWith('/reports/cash-bank/');
// Bank reconciliation (statements, matches) is owner-only too.
const isReconcilePath = (p: string) => p === '/reports/reconcile' || p.startsWith('/reports/reconcile/');

export function decideAccess({ pathname, search = '', member }: { pathname: string; search?: string; member: Member }): AccessDecision {
  if (isPublicPath(pathname) || isSignedInvoiceLink(pathname, search)) return { action: 'allow' };

  if (!member) return pathname === '/login' ? { action: 'allow' } : { action: 'redirect', to: '/login' };

  // Admins must finish the authenticator-app step before anything else.
  if (member.role === 'admin' && member.aal !== 'aal2') {
    return pathname === '/login/mfa' ? { action: 'allow' } : { action: 'redirect', to: '/login/mfa' };
  }

  if (isLoginPath(pathname)) return { action: 'redirect', to: '/' };
  if (member.role === 'user' && (isSettingsPath(pathname) || isStaffPath(pathname) || isPurchasesPath(pathname) || isCashBookPath(pathname) || isReconcilePath(pathname))) return { action: 'redirect', to: '/' };
  return { action: 'allow' };
}
