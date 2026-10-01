import { z } from 'zod';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIMES } from '@/lib/attachments';

// Bill photos: the declared type and size are validated here and again in Storage and the database.

const upload = {
  entity: z.literal('purchase_invoice', 'attachment_entity_invalid'),
  // Lower-cased: the storage path is built from it and the database accepts lower-case ids only.
  entityId: z.uuid('id_invalid').transform((v) => v.toLowerCase()),
  mime: z.enum(ATTACHMENT_MIMES, 'attachment_type_invalid'),
  bytes: z.number('attachment_size_invalid').int('attachment_size_invalid').min(1, 'attachment_size_invalid').max(ATTACHMENT_MAX_BYTES, 'attachment_too_big'),
};

export const uploadRequestSchema = z.object(upload);

export const recordAttachmentSchema = z.object({
  ...upload,
  /** The path the first call handed out; re-checked against its exact shape in the action. */
  path: z.string().max(200, 'text_long'),
});

export const attachmentIdSchema = z.object({ id: z.uuid('id_invalid') });
