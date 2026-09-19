import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { requestCodeSchema, verifyCodeSchema, verifyTotpSchema } from './auth';
import { inviteUserSchema, userIdSchema } from './users';

describe('sign-in schemas', () => {
  it('cleans up the email (trim, lower-case)', () => {
    expect(requestCodeSchema.parse({ email: '  Ratna@Example.COM ' }).email).toBe('ratna@example.com');
  });
  it('rejects a malformed email with an i18n key', () => {
    const r = requestCodeSchema.safeParse({ email: 'nope' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('email_invalid');
  });
  it('accepts exactly six digits', () => {
    expect(verifyCodeSchema.safeParse({ email: 'a@b.co', code: '123456' }).success).toBe(true);
    for (const bad of ['12345', '1234567', '12345a', '', '12 456']) {
      const r = verifyCodeSchema.safeParse({ email: 'a@b.co', code: bad });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toBe('code_invalid');
    }
  });
  it('authenticator code: six digits, factor optional', () => {
    expect(verifyTotpSchema.safeParse({ code: '000000' }).success).toBe(true);
    expect(verifyTotpSchema.safeParse({ code: '00000' }).success).toBe(false);
  });
});

describe('user schemas', () => {
  const good = { email: 'new@x.co', name: '  Suresh  ', role: 'user' };
  it('trims the name', () => {
    expect(inviteUserSchema.parse(good).name).toBe('Suresh');
  });
  it('only knows the two roles', () => {
    expect(inviteUserSchema.safeParse({ ...good, role: 'owner' }).success).toBe(false);
    expect(inviteUserSchema.safeParse({ ...good, role: 'admin' }).success).toBe(true);
  });
  it('needs a name of sensible length', () => {
    expect(inviteUserSchema.safeParse({ ...good, name: '   ' }).error?.issues[0]?.message).toBe('name_required');
    expect(inviteUserSchema.safeParse({ ...good, name: 'x'.repeat(81) }).error?.issues[0]?.message).toBe('name_long');
  });
  it('user id must be a uuid', () => {
    expect(userIdSchema.safeParse({ userId: 'abc' }).success).toBe(false);
    expect(userIdSchema.safeParse({ userId: '11111111-1111-4111-8111-111111111111' }).success).toBe(true);
  });
});

describe('every message key the schemas can produce exists in both languages', () => {
  const load = (l: string) => JSON.parse(readFileSync(path.join(__dirname, `../messages/${l}.json`), 'utf8'));
  const keys = ['email_invalid', 'code_invalid', 'name_required', 'name_long', 'role_invalid', 'id_invalid'];
  for (const locale of ['en', 'te']) {
    it(locale, () => {
      const field = load(locale).errors.field;
      for (const k of keys) expect(field[k], k).toBeTruthy();
    });
  }
});
