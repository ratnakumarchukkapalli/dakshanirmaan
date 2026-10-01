import 'server-only';
import { rows } from '@/lib/db';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;

export const ATTACHMENT_BUCKET = 'docs';
/** A bill carries a handful of photos; the cap keeps a stuck retry from filling Storage. */
export const MAX_ATTACHMENTS_PER_BILL = 10;

export interface AttachmentRow { id: string; mime: string; bytes: number; uploadedAt: string }

/** The attachments of one bill, oldest first. Owner-only through RLS: anyone else reads an empty list. */
export async function loadAttachments(supabase: Supabase, entityId: string): Promise<AttachmentRow[]> {
  const res = await supabase.from('attachments').select('id, mime, bytes, uploaded_at').eq('entity', 'purchase_invoice').eq('entity_id', entityId).order('uploaded_at');
  return rows<{ id: string; mime: string; bytes: number; uploaded_at: string }>(res, 'attachments')
    .map((a) => ({ id: a.id, mime: a.mime, bytes: Number(a.bytes), uploadedAt: a.uploaded_at }));
}

/**
 * Removes a draft bill's photos: each row first (the database refuses it for a posted bill), then the file.
 * Files are removed through the Storage API only (it refuses a plain SQL delete). Returns the first database
 * error, or null. A file that could not be removed is logged, not shown: the row is gone, so nothing points at it.
 */
export async function removeBillAttachments(supabase: Supabase, billId: string): Promise<{ message?: string; code?: string } | null> {
  const res = await supabase.from('attachments').select('id, storage_path').eq('entity', 'purchase_invoice').eq('entity_id', billId);
  if (res.error) return res.error;
  for (const a of res.data ?? []) {
    const del = await supabase.from('attachments').delete().eq('id', a.id).select('id');
    if (del.error) return del.error;
    await removeObject(supabase, a.storage_path as string);
  }
  return null;
}

/** Best effort: the Storage API reports failure in `error`; an orphaned file is logged for the owner's housekeeping. */
export async function removeObject(supabase: Supabase, path: string): Promise<void> {
  const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).remove([path]);
  if (error) console.error('[attachments] could not remove a stored file:', path, error.message);
}
