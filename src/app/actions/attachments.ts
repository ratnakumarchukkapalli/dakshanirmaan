'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult, type Failure } from '@/lib/action-result';
import { attachmentPath, ATTACHMENT_MAX_BYTES, isAttachmentPath, sniffMime } from '@/lib/attachments';
import { ATTACHMENT_BUCKET, MAX_ATTACHMENTS_PER_BILL, removeObject } from '@/lib/attachments-data';
import { requireAdminMember } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import { attachmentIdSchema, recordAttachmentSchema, uploadRequestSchema } from '@/schemas/attachments';

// Bill photos, OWNER-ONLY. Three steps, because the file goes from the phone straight to Storage and
// never through this server: (1) createAttachmentUpload checks the bill and hands out a one-use signed
// upload address for a path built here; (2) the browser uploads; (3) recordAttachment re-reads the stored
// file (size, and what its first bytes say it is) before the row is written. Storage and the database
// enforce the same limits (private bucket `docs`, 5 MB, jpeg/png/pdf, owner at aal2 only).

const bad = async (detail: string): Promise<Failure> => fail('validation', (await getTranslations('errors'))(`validation.${detail}`));

function revalidateBill(id: string) {
  revalidatePath(`/purchases/${id}`);
  revalidatePath(`/purchases/${id}/view`);
}

/** Step 1: may this bill take another file? Returns the path to upload to and the signed token for it. */
export async function createAttachmentUpload(input: unknown): Promise<ActionResult<{ path: string; token: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = uploadRequestSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();
  const { data: bill, error } = await supabase.from('purchase_invoices').select('id, status').eq('id', v.entityId).maybeSingle();
  if (error) return dbFailure(error);
  if (!bill) return bad('no_such_bill');
  if (bill.status === 'cancelled') return bad('attachment_entity_cancelled');

  const { count, error: countError } = await supabase.from('attachments').select('id', { count: 'exact', head: true }).eq('entity', v.entity).eq('entity_id', v.entityId);
  if (countError) return dbFailure(countError);
  if ((count ?? 0) >= MAX_ATTACHMENTS_PER_BILL) return bad('attachment_limit');

  const path = attachmentPath(v.entity, v.entityId, v.mime);
  const { data, error: signError } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUploadUrl(path);
  if (signError || !data) {
    console.error('[attachments] could not sign an upload:', signError?.message);
    return fail('internal', (await getTranslations('errors'))('internal'));
  }
  return ok({ path, token: data.token });
}

/** Step 3: the file is in Storage; check it really is what was declared, then record it. */
export async function recordAttachment(input: unknown): Promise<ActionResult<{ id: string; mime: string; bytes: number }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = recordAttachmentSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;
  if (!isAttachmentPath(v.path, v.entityId, v.mime)) return bad('attachment_path_invalid');

  const supabase = await createClient();
  const { data: blob, error: downloadError } = await supabase.storage.from(ATTACHMENT_BUCKET).download(v.path);
  if (downloadError || !blob) return bad('attachment_object_missing');

  // The stored file is the truth, not the declared numbers: wrong size or a different kind of file is thrown away.
  const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
  if (blob.size < 1 || blob.size > ATTACHMENT_MAX_BYTES || blob.size !== v.bytes || sniffMime(head) !== v.mime) {
    await removeObject(supabase, v.path);
    return bad(blob.size === v.bytes ? 'attachment_content_mismatch' : 'attachment_object_mismatch');
  }

  const { data: row, error } = await supabase
    .from('attachments')
    .insert({ entity: v.entity, entity_id: v.entityId, storage_path: v.path, mime: v.mime, bytes: blob.size })
    .select('id')
    .single();
  if (error) {
    // A retry of the same path hits the unique index and must not delete the file the first call recorded.
    if (error.code !== '23505') await removeObject(supabase, v.path);
    return dbFailure(error);
  }

  revalidateBill(v.entityId);
  return ok({ id: row.id as string, mime: v.mime, bytes: blob.size });
}

/** Removes one photo: the row first (the database refuses it while the bill is posted), then the file. */
export async function deleteAttachment(input: unknown): Promise<ActionResult> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = attachmentIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { data: found, error: readError } = await supabase.from('attachments').select('id, storage_path, entity_id').eq('id', parsed.data.id).maybeSingle();
  if (readError) return dbFailure(readError);
  if (!found) return bad('attachment_missing');

  const { data: removed, error } = await supabase.from('attachments').delete().eq('id', found.id).select('id');
  if (error) return dbFailure(error);
  if (!removed?.length) return bad('attachment_missing');
  await removeObject(supabase, found.storage_path as string);

  revalidateBill(found.entity_id as string);
  return ok();
}
