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
  otpError: null as AuthError | null,
  verifyError: null as AuthError | null,
  row: null as Record<string, unknown> | null,
  factors: { totp: [] as { id: string }[], all: [] as { id: string; factor_type: string; status: string }[] },
  verifyMfaError: null as AuthError | null,
  log: [] as string[],
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      signInWithOtp: async () => { a.log.push('signInWithOtp'); return { error: a.otpError }; },
      verifyOtp: async () => {
        a.log.push('verifyOtp');
        return a.verifyError ? { data: {}, error: a.verifyError } : { data: { user: { id: 'u-1' } }, error: null };
      },
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

import { requestCode, startTotpEnrollment, verifyCode, verifyTotp } from './auth';

// The limiters live for the life of the module, so each test uses its own email address.
let n = 0;
const email = () => `person${++n}@example.com`;

beforeEach(() => {
  a.otpError = null;
  a.verifyError = null;
  a.row = { role: 'user', is_active: true, locale: 'en' };
  a.factors = { totp: [], all: [] };
  a.verifyMfaError = null;
  a.log.length = 0;
  reset(null);
});

describe('requestCode', () => {
  it('gives the identical reply for an active, an unknown and a disabled email', async () => {
    const active = await requestCode({ email: email() });
    a.otpError = { status: 422, code: 'otp_disabled', message: 'Signups not allowed for otp' }; // unknown
    const unknown = await requestCode({ email: email() });
    a.otpError = { status: 400, code: 'user_banned', message: 'User is banned' }; // disabled
    const disabled = await requestCode({ email: email() });
    expect(active).toEqual({ ok: true, data: null });
    expect(unknown).toEqual(active);
    expect(disabled).toEqual(active);
  });
  it('a real fault on our side is not disguised as success', async () => {
    a.otpError = { status: 500, message: 'smtp exploded' };
    expect(await requestCode({ email: email() })).toMatchObject({ ok: false, code: 'internal', error: 'internal' });
    a.otpError = { message: 'network down' }; // no status at all
    expect(await requestCode({ email: email() })).toMatchObject({ ok: false, code: 'internal' });
  });
  it('the sign-in service refusing to send again (429) maps to rate_limited', async () => {
    a.otpError = { status: 429, code: 'over_email_send_rate_limit' };
    expect(await requestCode({ email: email() })).toEqual({ ok: false, code: 'rate_limited', error: 'rate_limited' });
  });
  it('our own limit refuses the 6th request in 15 minutes, before the sign-in service is called', async () => {
    const e = email();
    for (let i = 0; i < 5; i++) expect((await requestCode({ email: e })).ok).toBe(true);
    a.log.length = 0;
    expect(await requestCode({ email: e })).toEqual({ ok: false, code: 'rate_limited', error: 'rate_limited' });
    expect(a.log).toEqual([]);
  });
  it('a malformed email is a validation failure and sends nothing', async () => {
    expect(await requestCode({ email: 'nope' })).toMatchObject({ ok: false, code: 'validation', error: 'field.email_invalid' });
    expect(a.log).toEqual([]);
  });
});

describe('verifyCode', () => {
  const code = '123456';

  it('an active counter user goes to the app; an owner goes on to the authenticator step', async () => {
    expect(await verifyCode({ email: email(), code })).toEqual({ ok: true, data: { next: '/' } });
    a.row = { role: 'admin', is_active: true, locale: 'te' };
    expect(await verifyCode({ email: email(), code })).toEqual({ ok: true, data: { next: '/login/mfa' } });
  });
  it('a wrong code and a disabled or unknown member all give the same failure', async () => {
    a.verifyError = { status: 403, code: 'otp_expired' };
    const wrong = await verifyCode({ email: email(), code });
    a.verifyError = null;
    a.row = { role: 'user', is_active: false, locale: 'en' };
    const disabled = await verifyCode({ email: email(), code });
    a.row = null;
    const unknown = await verifyCode({ email: email(), code });
    expect(wrong).toEqual({ ok: false, code: 'validation', error: 'code_wrong' });
    expect(disabled).toEqual(wrong);
    expect(unknown).toEqual(wrong);
  });
  it('a disabled or unknown member is signed out again because the code check already created a session', async () => {
    a.row = { role: 'user', is_active: false, locale: 'en' };
    await verifyCode({ email: email(), code });
    expect(a.log).toContain('signOut:{"scope":"local"}');
    a.log.length = 0;
    a.row = null;
    await verifyCode({ email: email(), code });
    expect(a.log).toContain('signOut:{"scope":"local"}');
  });
  it('an active member is not signed out, and a wrong code creates nothing to sign out of', async () => {
    await verifyCode({ email: email(), code });
    expect(a.log.some((l) => l.startsWith('signOut'))).toBe(false);
    a.log.length = 0;
    a.verifyError = { status: 403 };
    await verifyCode({ email: email(), code });
    expect(a.log).toEqual(['verifyOtp']);
  });
  it('the 11th attempt in 15 minutes is refused as rate_limited without asking the sign-in service', async () => {
    const e = email();
    a.verifyError = { status: 403 };
    for (let i = 0; i < 10; i++) expect(await verifyCode({ email: e, code })).toMatchObject({ code: 'validation' });
    a.log.length = 0;
    expect(await verifyCode({ email: e, code })).toEqual({ ok: false, code: 'rate_limited', error: 'rate_limited' });
    expect(a.log).toEqual([]);
  });
  it('a malformed code is refused with the same wording as a wrong one', async () => {
    expect(await verifyCode({ email: email(), code: '12' })).toEqual({ ok: false, code: 'validation', error: 'code_wrong' });
    expect(a.log).toEqual([]);
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
