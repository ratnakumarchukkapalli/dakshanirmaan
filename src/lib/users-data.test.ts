import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { UsersPanel, type UserRow } from '@/components/users/UsersPanel';
import en from '@/messages/en.json';
import te from '@/messages/te.json';
import { dbError, reset, state, asAdmin, supabaseMock } from '@/test/harness';

vi.mock('server-only', () => ({}));
vi.mock('@/app/actions/admin', () => ({ disableUser: vi.fn(), enableUser: vi.fn(), inviteUser: vi.fn(), resetUserPassword: vi.fn() }));

import { loadTotpStatus, loadUserRows } from './users-data';

const OWNER1 = '11111111-1111-4111-8111-111111111111';
const OWNER2 = '22222222-2222-4222-8222-222222222222';
const OFF = '33333333-3333-4333-8333-333333333333';
const COUNTER = '44444444-4444-4444-8444-444444444444';
const people = [
  { user_id: OWNER1, email: 'a@x.co', name: 'Owner A', role: 'admin', is_active: true, invited_at: null },
  { user_id: OWNER2, email: 'b@x.co', name: 'Owner B', role: 'admin', is_active: true, invited_at: null },
  { user_id: OFF, email: 'c@x.co', name: 'Old Owner', role: 'admin', is_active: false, invited_at: null },
  { user_id: COUNTER, email: 'd@x.co', name: 'Counter', role: 'user', is_active: true, invited_at: null },
];

const client = async () => supabaseMock.createClient() as unknown as Parameters<typeof loadUserRows>[0];

function answer(totp: () => { data?: unknown; error?: { message: string } | null }) {
  state.respond = (c) => (c.rpc === 'owner_totp_status' ? totp() : c.op === 'select' ? { data: people, error: null } : { data: null, error: null });
}

beforeEach(() => reset(asAdmin()));

describe('loadUserRows: authenticator status (A1)', () => {
  it('fills in yes/no for each ACTIVE owner only', async () => {
    answer(() => ({ data: [{ user_id: OWNER1, has_totp: true }, { user_id: OWNER2, has_totp: false }, { user_id: OFF, has_totp: true }], error: null }));
    const rows = await loadUserRows(await client(), 'Asia/Kolkata');
    expect(Object.fromEntries(rows.map((r) => [r.userId, r.hasTotp]))).toEqual({ [OWNER1]: true, [OWNER2]: false, [OFF]: null, [COUNTER]: null });
    expect(state.calls.some((c) => c.rpc === 'owner_totp_status')).toBe(true);
  });
  it('shows nothing (null, never a false "no") when the function errors or answers oddly', async () => {
    answer(() => dbError('function owner_totp_status() does not exist', '42883'));
    expect((await loadUserRows(await client(), 'Asia/Kolkata')).every((r) => r.hasTotp === null)).toBe(true);
    answer(() => ({ data: 'nonsense', error: null }));
    expect((await loadUserRows(await client(), 'Asia/Kolkata')).every((r) => r.hasTotp === null)).toBe(true);
    answer(() => ({ data: [{ user_id: OWNER1, has_totp: 'maybe' }], error: null }));
    expect(await loadTotpStatus(await client())).toEqual(new Map());
  });
  it('an owner the function does not mention stays unknown, not "no"', async () => {
    answer(() => ({ data: [{ user_id: OWNER1, has_totp: true }], error: null }));
    const rows = await loadUserRows(await client(), 'Asia/Kolkata');
    expect(rows.find((r) => r.userId === OWNER2)?.hasTotp).toBeNull();
  });
});

describe('UsersPanel: authenticator chip', () => {
  const row = (over: Partial<UserRow>): UserRow => ({ userId: 'x', email: 'e@x.co', name: 'N', role: 'admin', isActive: true, invitedOn: null, hasTotp: null, ...over });
  const html = (users: UserRow[], messages = en, locale = 'en') =>
    renderToStaticMarkup(
      createElement(NextIntlClientProvider, { locale, messages } as never, createElement(UsersPanel, { users, currentUserId: 'me' })),
    );

  it('shows yes / no in English and Telugu, and nothing when unknown or not an active owner', () => {
    const yes = html([row({ hasTotp: true })]);
    expect(yes).toContain(en.users.totpYes);
    const no = html([row({ hasTotp: false })]);
    expect(no).toContain(en.users.totpNo);
    expect(html([row({ hasTotp: false })], te, 'te')).toContain(te.users.totpNo);
    const none = html([row({ hasTotp: null }), row({ userId: 'y', role: 'user' })]);
    expect(none).not.toContain(en.users.totpYes);
    expect(none).not.toContain(en.users.totpNo);
  });
});
