import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state } from '@/test/harness';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

vi.mock('@/lib/supabase/admin', async () => (await import('@/test/harness')).adminClientMock);

import { disableUser, enableUser, inviteUser, resetUserPassword } from './admin';

const ID = '11111111-1111-4111-8111-111111111111';
const invite = { email: 'Counter@Example.com', name: 'Suresh', role: 'user', password: 'a-long-enough-password' };

/** The sign-in service finds nothing to reuse and creates an account. */
function withNewAccount() {
  state.adminAuth.createUser = () => ({ data: { user: { id: ID } }, error: null });
  state.respond = (c) => (c.op === 'select' ? { data: [], error: null } : { data: null, error: null });
}

describe('inviteUser', () => {
  it('owner (aal2) creates the account and records the role', async () => {
    reset(asAdmin());
    withNewAccount();
    expect(await inviteUser(invite)).toEqual({ ok: true, data: { userId: ID } });
    expect(state.adminCalls[0]).toMatchObject({ fn: 'createUser', args: [{ email: 'counter@example.com', password: 'a-long-enough-password', email_confirm: true }] });
    expect(state.calls.find((c) => c.rpc === 'admin_set_user')?.payload).toMatchObject({ p_user_id: ID, p_role: 'user', p_is_active: true });
    expect(state.revalidated).toContain('/settings/users');
  });
  it('owner at aal1 is refused before either client is touched', async () => {
    reset(asAdmin('aal1'));
    expect(await inviteUser(invite)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
    expect(state.adminCalls).toHaveLength(0);
  });
  it('counter user is refused', async () => {
    reset(asCounter());
    expect(await inviteUser(invite)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.adminCalls).toHaveLength(0);
  });
  it('bad input goes through the shared validation message', async () => {
    reset(asAdmin());
    expect(await inviteUser({ ...invite, email: 'nope' })).toEqual({ ok: false, code: 'validation', error: 'field.email_invalid' });
    expect(state.adminCalls).toHaveLength(0);
  });
  it('maps the database rule about a duplicate email', async () => {
    reset(asAdmin());
    withNewAccount();
    state.respond = (c) => (c.op === 'rpc' ? dbError('DN_VALIDATION:email_taken') : { data: [], error: null });
    expect(await inviteUser(invite)).toEqual({ ok: false, code: 'validation', error: 'validation.email_taken' });
  });
  it('a person who is already a member is told so', async () => {
    reset(asAdmin());
    withNewAccount();
    state.respond = () => ({ data: [{ user_id: ID }], error: null });
    expect(await inviteUser(invite)).toEqual({ ok: false, code: 'validation', error: 'validation.already_member' });
  });
});

describe('disableUser / enableUser', () => {
  const member = { email: 'c@example.com', name: 'Suresh', role: 'user' };
  const found = (c: { op: string }) => (c.op === 'select' ? { data: [member], error: null } : { data: null, error: null });

  it('owner (aal2) disables: business record first, then the sign-in account is blocked', async () => {
    reset(asAdmin());
    state.respond = found;
    expect(await disableUser({ userId: ID })).toEqual({ ok: true, data: null });
    expect(state.calls.find((c) => c.rpc === 'admin_set_user')?.payload).toMatchObject({ p_is_active: false });
    expect(state.adminCalls[0]).toMatchObject({ fn: 'updateUserById', args: [ID, { ban_duration: '876000h' }] });
  });
  it('owner (aal2) enables: the ban is lifted', async () => {
    reset(asAdmin());
    state.respond = found;
    expect((await enableUser({ userId: ID })).ok).toBe(true);
    expect(state.adminCalls[0]).toMatchObject({ args: [ID, { ban_duration: 'none' }] });
  });
  it('owner at aal1 and counter user are refused, and nothing is touched', async () => {
    reset(asAdmin('aal1'));
    expect(await disableUser({ userId: ID })).toMatchObject({ ok: false, code: 'forbidden' });
    reset(asCounter());
    expect(await enableUser({ userId: ID })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
    expect(state.adminCalls).toHaveLength(0);
  });
  it('maps "there must always be an active owner"', async () => {
    reset(asAdmin());
    state.respond = (c) => (c.op === 'rpc' ? dbError('DN_VALIDATION:last_admin') : found(c));
    expect(await disableUser({ userId: ID })).toEqual({ ok: false, code: 'validation', error: 'validation.last_admin' });
    expect(state.adminCalls).toHaveLength(0);
  });
  it('reports a half-done change when the sign-in account cannot be blocked', async () => {
    reset(asAdmin());
    state.respond = found;
    state.adminAuth.updateUserById = () => ({ data: {}, error: { code: 'boom', message: 'x' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await disableUser({ userId: ID })).toEqual({ ok: false, code: 'partial', error: 'partial_disable' });
    spy.mockRestore();
  });
});

describe('resetUserPassword', () => {
  it('an owner sets a new password for someone in the business', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: [{ user_id: ID }], error: null });
    expect(await resetUserPassword({ userId: ID, password: 'a-brand-new-password' })).toEqual({ ok: true, data: null });
    expect(state.adminCalls[0]).toMatchObject({ fn: 'updateUserById', args: [ID, { password: 'a-brand-new-password' }] });
  });

  it('is refused for a counter user and an owner at step 1, and a short password never reaches the sign-in service', async () => {
    reset(asCounter());
    expect(await resetUserPassword({ userId: ID, password: 'a-brand-new-password' })).toMatchObject({ ok: false, code: 'forbidden' });
    reset(asAdmin('aal1'));
    expect(await resetUserPassword({ userId: ID, password: 'a-brand-new-password' })).toMatchObject({ ok: false, code: 'forbidden' });
    reset(asAdmin());
    expect(await resetUserPassword({ userId: ID, password: 'short' })).toMatchObject({ ok: false, code: 'validation', error: 'field.password_short' });
    expect(state.adminCalls).toHaveLength(0);
  });

  it('only people already in the business can be reset', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: [], error: null });
    expect(await resetUserPassword({ userId: ID, password: 'a-brand-new-password' })).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_user' });
    expect(state.adminCalls).toHaveLength(0);
  });
});
