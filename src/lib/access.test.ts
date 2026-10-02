import { describe, expect, it } from 'vitest';
import { decideAccess, type Member } from './access';

const go = (pathname: string, member: Member) => decideAccess({ pathname, member });
const redirect = (to: string) => ({ action: 'redirect', to });
const allow = { action: 'allow' };

const counter: Member = { role: 'user', aal: 'aal1' };
const adminStep1: Member = { role: 'admin', aal: 'aal1' };
const admin: Member = { role: 'admin', aal: 'aal2' };

describe('signed out (no session, not a member, or session too old)', () => {
  it('is sent to /login from anywhere else', () => {
    expect(go('/', null)).toEqual(redirect('/login'));
    expect(go('/sales/new', null)).toEqual(redirect('/login'));
    expect(go('/login/mfa', null)).toEqual(redirect('/login'));
    expect(go('/settings/users', null)).toEqual(redirect('/login'));
  });
  it('may see /login', () => {
    expect(go('/login', null)).toEqual(allow);
  });
  it('can still fetch the manifest and service worker', () => {
    expect(go('/api/manifest.webmanifest', null)).toEqual(allow);
    expect(go('/sw.js', null)).toEqual(allow);
  });
});

describe('counter user', () => {
  it('reaches every screen except settings, staff and purchases (owner-only)', () => {
    expect(go('/', counter)).toEqual(allow);
    expect(go('/parties', counter)).toEqual(allow);
    expect(go('/stock', counter)).toEqual(allow);
    expect(go('/staff', counter)).toEqual(redirect('/'));
    // Reports are for everyone, except the cash & bank book (owner-only); the others stay open.
    expect(go('/reports', counter)).toEqual(allow);
    expect(go('/reports/day-close', counter)).toEqual(allow);
    expect(go('/reports/aging', counter)).toEqual(allow);
    expect(go('/reports/cash-bank', counter)).toEqual(redirect('/'));
    expect(go('/reports/cash-bank-lookalike', counter)).toEqual(allow);
    // Bank reconciliation: the list and a statement are owner-only.
    expect(go('/reports/reconcile', counter)).toEqual(redirect('/'));
    expect(go('/reports/reconcile/3f2b1c1e-0000-4000-8000-000000000000', counter)).toEqual(redirect('/'));
    expect(go('/reports/reconcile-lookalike', counter)).toEqual(allow);
    // Its Excel route decides for itself (403), so a download is never a redirect.
    expect(go('/api/reports/cash-bank/xlsx', counter)).toEqual(allow);
    expect(go('/staff/3f2b1c1e-0000-4000-8000-000000000000', counter)).toEqual(redirect('/'));
    expect(go('/staffing', counter)).toEqual(allow);
    // Supplier bills: the list, a draft, the posted view and the new-bill form are all owner-only.
    expect(go('/purchases', counter)).toEqual(redirect('/'));
    expect(go('/purchases/new', counter)).toEqual(redirect('/'));
    expect(go('/purchases/3f2b1c1e-0000-4000-8000-000000000000/view', counter)).toEqual(redirect('/'));
    expect(go('/purchases-lookalike', counter)).toEqual(allow);
    expect(go('/settings', counter)).toEqual(redirect('/'));
    expect(go('/settings/users', counter)).toEqual(redirect('/'));
  });
  it('reaches quotations (any active member may quote, accept and convert)', () => {
    expect(go('/sales/quotes', counter)).toEqual(allow);
    expect(go('/sales/quotes/new', counter)).toEqual(allow);
    expect(go('/sales/quotes/3f2b1c1e-0000-4000-8000-000000000000', counter)).toEqual(allow);
  });
  it('is bounced off the login screens', () => {
    expect(go('/login', counter)).toEqual(redirect('/'));
    expect(go('/login/mfa', counter)).toEqual(redirect('/'));
  });
});

describe('admin who has not done the authenticator step', () => {
  it('is held on /login/mfa and nowhere else', () => {
    expect(go('/', adminStep1)).toEqual(redirect('/login/mfa'));
    expect(go('/settings/users', adminStep1)).toEqual(redirect('/login/mfa'));
    expect(go('/login', adminStep1)).toEqual(redirect('/login/mfa'));
    expect(go('/login/mfa', adminStep1)).toEqual(allow);
  });
});

describe('admin with the authenticator step done', () => {
  it('reaches everything, including settings', () => {
    expect(go('/', admin)).toEqual(allow);
    expect(go('/settings/users', admin)).toEqual(allow);
  });
  it('is bounced off the login screens', () => {
    expect(go('/login', admin)).toEqual(redirect('/'));
    expect(go('/login/mfa', admin)).toEqual(redirect('/'));
  });
});

describe('the development login bypass is gone', () => {
  it('no environment switch can let an anonymous request in', () => {
    process.env.DN_AUTH_GATE = 'off';
    expect(go('/', null)).toEqual(redirect('/login'));
    delete process.env.DN_AUTH_GATE;
  });
});

describe('signed invoice links', () => {
  const id = 'd0000000-0000-0000-0000-000000000001';
  const pdf = `/api/invoices/${id}/pdf`;
  const via = (pathname: string, search: string) => decideAccess({ pathname, search, member: null });

  it('lets exactly one shape past the gate, and only with a signature', () => {
    expect(via(pdf, '?exp=1&sig=abc')).toEqual(allow);
    expect(via(pdf, '')).toEqual(redirect('/login'));
    expect(via(pdf, '?exp=1')).toEqual(redirect('/login'));
  });
  it('does not open any other API path or a look-alike', () => {
    expect(via(`/api/invoices/${id}`, '?sig=x')).toEqual(redirect('/login'));
    expect(via(`/api/invoices/${id}/pdf/extra`, '?sig=x')).toEqual(redirect('/login'));
    expect(via(`/api/invoices/not-an-id/pdf`, '?sig=x')).toEqual(redirect('/login'));
    expect(via(`/api/invoices/${id}/xlsx`, '?sig=x')).toEqual(redirect('/login'));
    expect(via('/api/reports/gstr1', '?sig=x')).toEqual(redirect('/login'));
    expect(via('/sales', '?sig=x')).toEqual(redirect('/login'));
  });
});
