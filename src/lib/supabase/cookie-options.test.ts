import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionCookieOptions } from './cookie-options';

const created: { kind: string; options: { cookieOptions?: Record<string, unknown> } }[] = [];
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_u: string, _k: string, options: never) => {
    created.push({ kind: 'server', options });
    return { auth: { getUser: async () => ({ data: { user: null } }) } };
  },
  createBrowserClient: (_u: string, _k: string, options: never) => {
    created.push({ kind: 'browser', options });
    return {};
  },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }) }));
vi.mock('next/server', () => ({ NextResponse: { next: () => ({ cookies: { set: () => undefined } }) } }));

beforeEach(() => {
  created.length = 0;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'pub');
});

describe('sessionCookieOptions', () => {
  it('is secure in production and not over plain-http dev', () => {
    expect(sessionCookieOptions('production').secure).toBe(true);
    expect(sessionCookieOptions('development').secure).toBe(false);
    expect(sessionCookieOptions('test').secure).toBe(false);
  });
  it('lasts 8 hours, same-site lax, whole site', () => {
    expect(sessionCookieOptions('production')).toMatchObject({ maxAge: 8 * 3600, sameSite: 'lax', path: '/' });
  });
});

describe('all three Supabase clients get the session cookie options', () => {
  const expected = { maxAge: 28800, sameSite: 'lax', path: '/' };

  it('server client', async () => {
    const { createClient } = await import('./server');
    await createClient();
    expect(created[0]!.options.cookieOptions).toMatchObject(expected);
  });
  it('browser client', async () => {
    const { createClient } = await import('./client');
    createClient();
    expect(created[0]!.options.cookieOptions).toMatchObject(expected);
  });
  it('proxy client', async () => {
    const { readSession } = await import('./proxy');
    await readSession({ cookies: { getAll: () => [], set: () => undefined }, headers: new Headers() } as never, new Headers());
    expect(created[0]!.kind).toBe('server');
    expect(created[0]!.options.cookieOptions).toMatchObject(expected);
  });
});
