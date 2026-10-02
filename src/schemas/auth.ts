import { z } from 'zod';

// Messages are i18n keys under `errors.field.*`; forms translate them, so the same schema
// serves the browser form and the server action.
export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'email_invalid')
  .pipe(z.email('email_invalid'));

export const codeField = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'code_invalid');

/** A password being SET (a new person, a reset, a change): at least 8 characters, at most 72 (the sign-in service's limit). */
export const passwordField = z.string().min(8, 'password_short').max(72, 'password_long');

/** Signing in: any non-empty password is submitted; the length rule is not repeated here so it is not advertised to a guesser. */
export const signInSchema = z.object({ email: emailField, password: z.string().min(1, 'password_required').max(72, 'password_long') });

/** An owner's password is longer: it guards the books, the bank data and every counter account. */
export const ADMIN_PASSWORD_MIN = 12;
export const adminPasswordField = z.string().min(ADMIN_PASSWORD_MIN, 'password_short_admin').max(72, 'password_long');

/** Changing one's own password needs the current one too, so a borrowed, unlocked session cannot take the account over. */
const currentPasswordField = z.string('password_required').min(1, 'password_required').max(72, 'password_long');
export const changePasswordSchema = z.object({ currentPassword: currentPasswordField, password: passwordField });
export const changeAdminPasswordSchema = z.object({ currentPassword: currentPasswordField, password: adminPasswordField });
/** The schema for this person's role (owner: 12+ characters, counter staff: 8+). */
export const changePasswordSchemaFor = (role: 'admin' | 'user') => (role === 'admin' ? changeAdminPasswordSchema : changePasswordSchema);
export const totpCodeSchema = z.object({ code: codeField });
export const verifyTotpSchema = z.object({ factorId: z.string().min(1).optional(), code: codeField });

export type SignInInput = z.infer<typeof signInSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
