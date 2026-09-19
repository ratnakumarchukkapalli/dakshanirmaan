import { z } from 'zod';
import { emailField } from './auth';

export const roleField = z.enum(['admin', 'user'], 'role_invalid');

export const inviteUserSchema = z.object({
  email: emailField,
  name: z.string().trim().min(1, 'name_required').max(80, 'name_long'),
  role: roleField,
});

export const userIdSchema = z.object({ userId: z.uuid('id_invalid') });

export type InviteUserInput = z.infer<typeof inviteUserSchema>;
