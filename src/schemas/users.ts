import { z } from 'zod';
import { emailField, passwordField } from './auth';

export const roleField = z.enum(['admin', 'user'], 'role_invalid');

export const inviteUserSchema = z.object({
  email: emailField,
  name: z.string().trim().min(1, 'name_required').max(80, 'name_long'),
  role: roleField,
  /** The starting password the owner hands over in person. */
  password: passwordField,
});

export const resetPasswordSchema = z.object({ userId: z.uuid('id_invalid'), password: passwordField });

export const userIdSchema = z.object({ userId: z.uuid('id_invalid') });

export type InviteUserInput = z.infer<typeof inviteUserSchema>;
