import { z } from 'zod';
import { ADMIN_PASSWORD_MIN, emailField, passwordField } from './auth';
import { noControlChars } from './common';

export const roleField = z.enum(['admin', 'user'], 'role_invalid');

export const inviteUserSchema = z.object({
  email: emailField,
  name: z.string().trim().min(1, 'name_required').max(80, 'name_long').refine(noControlChars, 'text_invalid'),
  role: roleField,
  /** The starting password the owner hands over in person. */
  password: passwordField,
}).superRefine((v, ctx) => {
  // An owner's starting password is held to the owner minimum.
  if (v.role === 'admin' && v.password.length < ADMIN_PASSWORD_MIN) ctx.addIssue({ code: 'custom', path: ['password'], message: 'password_short_admin' });
});

export const resetPasswordSchema = z.object({ userId: z.uuid('id_invalid'), password: passwordField });

export const userIdSchema = z.object({ userId: z.uuid('id_invalid') });

export type InviteUserInput = z.infer<typeof inviteUserSchema>;
