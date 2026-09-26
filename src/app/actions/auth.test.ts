import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, reset } from '@/test/harness';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/i18n/cookie', () => ({ writeLocaleCookie: vi.fn() }));

// One caller address, so the per-(email + address) counters behave as they would for one person.
vi.mock('@/lib/http', () => ({ clientIp: async () => '203.0.113.7' }));

interface AuthError { status?: number; code?: string; message?: string }
const a = vi.hoisted(() => ({
  signInError: null as AuthError | null,
  updateError: null as AuthError | null,
  row: null as Record<string, unknown> | null,
  factors: { totp: [] as { id: string }[], all: [] as { id: string; factor_type: string; status: string }[] },
  verifyMfaError: null as AuthError | null,
  log: [] as string[],
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      signInWithPassword: async () => {
        a.log.push('signInWithPassword');
        return a.signInError ? { data: {}, error: a.signInError } : { data: { user: { id: 'u-1' } }, error: null };
      },
      updateUser: async (attrs: unknown) => { a.log.push(`updateUser:${JSON.stringify(attrs)}`); return { error: a.updateError }; },
      signOut: async (opts: unknown) => { a.log.push(`signOut:${JSON.stringify(opts)}`); return { error: null }; },
      mfa: {
        listFactors: async () => ({ data: a.factors }),
        unenroll: async () => { a.log.push('unenroll'); return {}; },
        enroll: async () => { a.log.push('enroll'); return { data: { id: 'f-1', totp: { qr_code: 'qr', secret: 'sec' } }, error: null }; },
        challengeAndVerify: async () => { a.log.push('challengeAndVerify'); return { error: a.verifyMfaError }; },
      },
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: a.row }) }) }) }),
  }),
}));

import { changePassword, signIn, startTotpEnrollment, verifyTotp } from './auth';

// The limiters live for the life of the module, so each test uses its own email address.
let n = 0;
const email = () => `person${++n}@example.com`;

beforeEach(() => {
  a.signInError = null;
  a.updateError = null;
  a.row = { role: 'user', is_active: true, locale: 'en' };
  a.factors = { totp: [], all: [] };
  a.verifyMfaError = null;
  a.log.length = 0;
  reset(null);
});

describe('signIn', () => {
  const password = 'a-long-enough-password';

  it('an active counter user goes to the app; an owner goes on to the authenticator step', async () => {
    expect(await signIn({ email: email(), password })).toEqual({ ok: true, data: { next: '/' } });
    a.row = { role: 'admin', is_active: true, locale: 'te' };
    expect(await signIn({ email: email(), password })).toEqual({ ok: true, data: { next: '/login/mfa' } });
  });
  it('a wrong password, a disabled member and an unknown member all give the same failure', async () => {
    a.signInError = { status: 400, code: 'invalid_credentials' };
    const wrong = await signIn({ email: email(), password });
    a.signInError = null;
    a.row = { role: 'user', is_active: false, locale: 'en' };
    const disabled = await signIn({ email: email(), password });
    a.row = null;
    const unknown = await signIn({ email: email(), password });
    expect(wrong).toEqual({ ok: false, code: 'validation', error: 'sign_in_failed' });
    expect(disabled).toEqual(wrong);
    expect(unknown).toEqual(wrong);
  });
  it('a disabled or unknown member is signed out again because the password check already created a session', async () => {
    a.row = { role: 'user', is_active: false, locale: 'en' };
    await signIn({ email: email(), password });
    expect(a.log).toContain('signOut:{"scope":"local"}');
    a.log.length = 0;
    a.row = null;
    await signIn({ email: email(), password });
    expect(a.log).toContain('signOut:{"scope":"local"}');
  });
  it('an active member is not signed out, and a wrong password creates nothing to sign out of', async () => {
    await signIn({ email: email(), password });
    expect(a.log.some((l) => l.startsWith('signOut'))).toBe(false);
    a.log.length = 0;
    a.signInError = { status: 400 };
    await signIn({ email: email(), password });
    expect(a.log).toEqual(['signInWithPassword']);
  });
  it('a real fault on our side is not disguised as a wrong password, and the service rate limit maps to rate_limited', async () => {
    a.signInError = { status: 500, message: 'db down' };
    expect(await signIn({ email: email(), password })).toMatchObject({ ok: false, code: 'internal', error: 'internal' });
    a.signInError = { message: 'network down' };
    expect(await signIn({ email: email(), password })).toMatchObject({ ok: false, code: 'internal' });
    a.signInError = { status: 429, code: 'over_request_rate_limit' };
    expect(await signIn({ email: email(), password })).toEqual({ ok: false, code: 'rate_limited', error: 'rate_limited' });
  });
  it('the 11th attempt in 15 minutes is refused as rate_limited without asking the sign-in service', async () => {
    const e = email();
    a.signInError = { status: 400, code: 'invalid_credentials' };
    for (let i = 0; i < 10; i++) expect(await signIn({ email: e, password })).toMatchObject({ code: 'validation' });
    a.log.length = 0;
    expect(await signIn({ email: e, password })).toEqual({ ok: false, code: 'rate_limited', error: 'rate_limited' });
    expect(a.log).toEqual([]);
  });
  it('a malformed email or an empty password is refused with the same wording as a wrong one, before any call', async () => {
    expect(await signIn({ email: 'nope', password })).toEqual({ ok: false, code: 'validation', error: 'sign_in_failed' });
    expect(await signIn({ email: email(), password: '' })).toEqual({ ok: false, code: 'validation', error: 'sign_in_failed' });
    expect(a.log).toEqual([]);
  });
});

describe('changePassword', () => {
  it('a counter user and an owner past the authenticator step change their own password', async () => {
    reset(asCounter());
    expect(await changePassword({ password: 'a-brand-new-password' })).toEqual({ ok: true, data: null });
    expect(a.log).toContain('updateUser:{"password":"a-brand-new-password"}');
    a.log.length = 0;
    reset(asAdmin('aal2'));
    expect((await changePassword({ password: 'another-new-password' })).ok).toBe(true);
  });
  it('an owner at step 1 and a signed-out visitor are refused before anything is called', async () => {
    reset(asAdmin('aal1'));
    expect(await changePassword({ password: 'a-brand-new-password' })).toMatchObject({ ok: false, code: 'forbidden' });
    reset(null);
    expect(await changePassword({ password: 'a-brand-new-password' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(a.log).toEqual([]);
  });
  it('a short password is refused, and the same password is said plainly', async () => {
    reset(asCounter());
    expect(await changePassword({ password: 'short' })).toMatchObject({ ok: false, code: 'validation', error: 'field.password_short' });
    a.updateError = { code: 'same_password' };
    expect(await changePassword({ password: 'a-brand-new-password' })).toMatchObject({ ok: false, code: 'validation', error: 'validation.same_password' });
  });
});

describe('startTotpEnrollment', () => {
  it('refuses a counter user and a signed-out caller, touching nothing', async () => {
    reset(asCounter());
    expect(await startTotpEnrollment()).toEqual({ ok: false, code: 'forbidden', error: 'forbidden' });
    reset(null);
    expect(await startTotpEnrollment()).toMatchObject({ ok: false, code: 'forbidden' });
    expect(a.log).toEqual([]);
  });
  it('an owner gets the QR code and secret', async () => {
    reset(asAdmin('aal1'));
    expect(await startTotpEnrollment()).toEqual({ ok: true, data: { factorId: 'f-1', qr: 'qr', secret: 'sec' } });
  });
  it('an owner who already has an authenticator cannot enrol a second one', async () => {
    reset(asAdmin('aal1'));
    a.factors = { totp: [{ id: 'f-old' }], all: [] };
    expect(await startTotpEnrollment()).toMatchObject({ ok: false, code: 'validation', error: 'mfa_already' });
    expect(a.log).not.toContain('enroll');
  });
});

describe('verifyTotp', () => {
  const input = { code: '123456' };

  it('refuses a counter user and a signed-out caller before any factor is challenged', async () => {
    reset(asCounter());
    expect(await verifyTotp(input)).toEqual({ ok: false, code: 'forbidden', error: 'forbidden' });
    reset(null);
    expect(await verifyTotp(input)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(a.log).not.toContain('challengeAndVerify');
  });
  it('an owner with a correct code passes; a wrong code is the uniform failure', async () => {
    reset(asAdmin('aal1'));
    a.factors = { totp: [{ id: 'f-1' }], all: [] };
    expect(await verifyTotp(input)).toEqual({ ok: true, data: null });
    a.verifyMfaError = { status: 400 };
    expect(await verifyTotp(input)).toEqual({ ok: false, code: 'validation', error: 'code_wrong' });
  });
  it('an owner with no authenticator set up cannot verify one', async () => {
    reset(asAdmin('aal1'));
    expect(await verifyTotp(input)).toMatchObject({ ok: false, code: 'validation', error: 'code_wrong' });
    expect(a.log).not.toContain('challengeAndVerify');
  });
  it('is limited to 10 attempts in 15 minutes per person', async () => {
    reset({ ...asAdmin('aal1'), userId: 'u-rate-limited' });
    a.factors = { totp: [{ id: 'f-1' }], all: [] };
    a.verifyMfaError = { status: 400 };
    for (let i = 0; i < 10; i++) expect(await verifyTotp(input)).toMatchObject({ code: 'validation' });
    a.log.length = 0;
    expect(await verifyTotp(input)).toEqual({ ok: false, code: 'rate_limited', error: 'rate_limited' });
    expect(a.log).toEqual([]);
  });
});
