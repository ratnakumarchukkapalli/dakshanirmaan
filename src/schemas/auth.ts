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

export const requestCodeSchema = z.object({ email: emailField });
export const verifyCodeSchema = z.object({ email: emailField, code: codeField });
export const totpCodeSchema = z.object({ code: codeField });
export const verifyTotpSchema = z.object({ factorId: z.string().min(1).optional(), code: codeField });

export type RequestCodeInput = z.infer<typeof requestCodeSchema>;
export type VerifyCodeInput = z.infer<typeof verifyCodeSchema>;
