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

/** A password being SET (a new person, a reset, a change): at least 12 characters, at most 72 (the sign-in service's limit). */
export const passwordField = z.string().min(12, 'password_short').max(72, 'password_long');

/** Signing in: any non-empty password is submitted; the length rule is not repeated here so it is not advertised to a guesser. */
export const signInSchema = z.object({ email: emailField, password: z.string().min(1, 'password_required').max(72, 'password_long') });
export const changePasswordSchema = z.object({ password: passwordField });
export const totpCodeSchema = z.object({ code: codeField });
export const verifyTotpSchema = z.object({ factorId: z.string().min(1).optional(), code: codeField });

export type SignInInput = z.infer<typeof signInSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
