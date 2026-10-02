import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changePasswordSchema, changePasswordSchemaFor, signInSchema, verifyTotpSchema } from './auth';
import { inviteUserSchema, userIdSchema } from './users';

describe('sign-in schemas', () => {
  it('cleans up the email (trim, lower-case)', () => {
    expect(signInSchema.parse({ email: '  Ratna@Example.COM ', password: 'x' }).email).toBe('ratna@example.com');
  });
  it('rejects a malformed email with an i18n key', () => {
    const r = signInSchema.safeParse({ email: 'nope', password: 'x' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('email_invalid');
  });
  it('sign-in asks only for a non-empty password (the length rule is not shown to a guesser)', () => {
    expect(signInSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    expect(signInSchema.safeParse({ email: 'a@b.co', password: '' }).error?.issues[0]?.message).toBe('password_required');
  });
  it('a password being set needs 8 to 72 characters', () => {
    const cur = { currentPassword: 'old-password' };
    expect(changePasswordSchema.safeParse({ ...cur, password: 'x'.repeat(7) }).error?.issues[0]?.message).toBe('password_short');
    expect(changePasswordSchema.safeParse({ ...cur, password: 'x'.repeat(8) }).success).toBe(true);
    expect(changePasswordSchema.safeParse({ ...cur, password: 'x'.repeat(73) }).error?.issues[0]?.message).toBe('password_long');
  });
  it('changing a password needs the current one; an owner needs 12+ characters', () => {
    expect(changePasswordSchema.safeParse({ password: 'x'.repeat(8) }).error?.issues[0]?.message).toBe('password_required');
    const cur = { currentPassword: 'old-password' };
    expect(changePasswordSchemaFor('admin').safeParse({ ...cur, password: 'x'.repeat(11) }).error?.issues[0]?.message).toBe('password_short_admin');
    expect(changePasswordSchemaFor('admin').safeParse({ ...cur, password: 'x'.repeat(12) }).success).toBe(true);
    expect(changePasswordSchemaFor('user').safeParse({ ...cur, password: 'x'.repeat(8) }).success).toBe(true);
  });
  it('inviting an owner holds the starting password to 12 characters; a counter person keeps 8', () => {
    const base = { email: 'o@x.co', name: 'Owner' };
    expect(inviteUserSchema.safeParse({ ...base, role: 'admin', password: 'x'.repeat(11) }).error?.issues[0]?.message).toBe('password_short_admin');
    expect(inviteUserSchema.safeParse({ ...base, role: 'admin', password: 'x'.repeat(12) }).success).toBe(true);
    expect(inviteUserSchema.safeParse({ ...base, role: 'user', password: 'x'.repeat(8) }).success).toBe(true);
  });
  it('authenticator code: six digits, factor optional', () => {
    expect(verifyTotpSchema.safeParse({ code: '000000' }).success).toBe(true);
    expect(verifyTotpSchema.safeParse({ code: '00000' }).success).toBe(false);
  });
});

describe('user schemas', () => {
  const good = { email: 'new@x.co', name: '  Suresh  ', role: 'user', password: 'a-long-enough-password' };
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
  it('a starting password is required and at least 8 characters', () => {
    expect(inviteUserSchema.safeParse({ ...good, password: 'short' }).error?.issues[0]?.message).toBe('password_short');
  });
  it('user id must be a uuid', () => {
    expect(userIdSchema.safeParse({ userId: 'abc' }).success).toBe(false);
    expect(userIdSchema.safeParse({ userId: '11111111-1111-4111-8111-111111111111' }).success).toBe(true);
  });
});

describe('every message key the schemas can produce exists in both languages', () => {
  const load = (l: string) => JSON.parse(readFileSync(path.join(__dirname, `../messages/${l}.json`), 'utf8'));
  const keys = ['email_invalid', 'code_invalid', 'name_required', 'name_long', 'role_invalid', 'id_invalid', 'password_short', 'password_long', 'password_required'];
  for (const locale of ['en', 'te']) {
    it(locale, () => {
      const field = load(locale).errors.field;
      for (const k of keys) expect(field[k], k).toBeTruthy();
    });
  }
});
