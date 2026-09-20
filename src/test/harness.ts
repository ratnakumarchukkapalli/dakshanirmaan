// Shared stubs for server-action tests. Each test file registers the mocks (vi.mock is hoisted
// per file) and then drives `state`:
//
//   vi.mock('server-only', () => ({}));
//   vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
//   vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
//   vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
//   vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);
//
// The Supabase client is a chainable, thenable stub that records every call and answers with
// whatever `state.respond` returns. `t` echoes the message key, and `t.has` checks the real
// English messages, so a test proves the mapped key exists.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CurrentMember } from '@/lib/auth/current';

export interface Call {
  table?: string;
  rpc?: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'rpc';
  payload?: Record<string, unknown> | Record<string, unknown>[];
  filters: [string, unknown][];
}
export interface Answer {
  data?: unknown;
  error?: { message: string; code?: string } | null;
  count?: number | null;
}

const fresh = () => ({
  member: null as CurrentMember | null,
  calls: [] as Call[],
  adminCalls: [] as { fn: string; args: unknown[] }[],
  revalidated: [] as string[],
  respond: ((): Answer => ({ data: [{ id: 'row-1' }], error: null, count: 0 })) as (call: Call) => Answer,
  adminAuth: {} as Record<string, (...args: unknown[]) => unknown>,
});
export const state = fresh();

export const asAdmin = (aal: 'aal1' | 'aal2' = 'aal2'): CurrentMember => ({ userId: 'u-admin', role: 'admin', name: 'Owner', aal });
export const asCounter = (): CurrentMember => ({ userId: 'u-counter', role: 'user', name: 'Counter', aal: 'aal1' });

/** Call before each test. */
export function reset(member: CurrentMember | null) {
  Object.assign(state, fresh(), { member });
}

/** A Postgres-style failure the way supabase-js reports it. */
export const dbError = (message: string, code?: string) => ({ data: null, error: { message, code } });

function builder(call: Call) {
  let single = false;
  const b: Record<string, unknown> = {};
  const chain = (name: string) => (...args: unknown[]) => {
    if (name === 'eq' || name === 'neq' || name === 'in' || name === 'is') call.filters.push([String(args[0]), args[1]]);
    if (name === 'single' || name === 'maybeSingle') single = true;
    return b;
  };
  for (const name of ['select', 'eq', 'neq', 'in', 'is', 'or', 'ilike', 'order', 'single', 'maybeSingle', 'limit']) b[name] = chain(name);
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    const a = state.respond(call);
    let data = a.data ?? null;
    if (single && Array.isArray(data)) data = data[0] ?? null;
    return Promise.resolve({ data, error: a.error ?? null, count: a.count ?? null }).then(resolve, reject);
  };
  return b;
}

const start = (table: string) => ({
  select: () => { const c: Call = { table, op: 'select', filters: [] }; state.calls.push(c); return builder(c); },
  insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => { const c: Call = { table, op: 'insert', payload, filters: [] }; state.calls.push(c); return builder(c); },
  delete: () => { const c: Call = { table, op: 'delete', filters: [] }; state.calls.push(c); return builder(c); },
  update: (payload: Record<string, unknown>) => { const c: Call = { table, op: 'update', payload, filters: [] }; state.calls.push(c); return builder(c); },
});

export const supabaseMock = {
  createClient: async () => ({
    from: (table: string) => start(table),
    rpc: (fn: string, args: Record<string, unknown>) => {
      const c: Call = { rpc: fn, op: 'rpc', payload: args, filters: [] };
      state.calls.push(c);
      return builder(c);
    },
  }),
};

export const adminClientMock = {
  createAdminClient: () => ({
    auth: {
      admin: new Proxy({}, {
        get: (_t, fn: string) => async (...args: unknown[]) => {
          state.adminCalls.push({ fn, args });
          return state.adminAuth[fn]?.(...args) ?? { data: {}, error: null };
        },
      }),
    },
  }),
};

export const currentMock = { getCurrentMember: async () => state.member };
export const cacheMock = { revalidatePath: (p: string) => { state.revalidated.push(p); } };

const en = JSON.parse(readFileSync(path.join(__dirname, '../messages/en.json'), 'utf8')) as Record<string, unknown>;
const lookup = (ns: string, key: string) =>
  [ns, ...key.split('.')].reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);

export const intlMock = {
  getTranslations: async (ns: string) => Object.assign((key: string) => key, { has: (key: string) => typeof lookup(ns, key) === 'string' }),
};
