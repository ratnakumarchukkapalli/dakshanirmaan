// Bill photos and other attachments. The rules below mirror the database (table `attachments`, bucket
// `docs`): the database and Storage enforce them too, this is the early, friendly layer.

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_MIMES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIMES)[number];

const EXTENSION: Record<AttachmentMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

/** `purchase_invoice/<bill id>/<uuid>.<ext>`: built here from ids and the type, never from a file name the client sent. */
export function attachmentPath(entity: 'purchase_invoice', entityId: string, mime: AttachmentMime): string {
  return `${entity}/${entityId}/${crypto.randomUUID()}.${EXTENSION[mime]}`;
}

const PATH_PATTERN = /^purchase_invoice\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf)$/;

/** Is this the exact shape of path the server builds, for this bill and this type? */
export function isAttachmentPath(path: string, entityId: string, mime: AttachmentMime): boolean {
  const m = PATH_PATTERN.exec(path);
  return !!m && m[1] === entityId && m[2] === EXTENSION[mime];
}

/** What the first bytes of a file say it is (the declared type is only a claim). */
export function sniffMime(head: Uint8Array): AttachmentMime | null {
  const at = (i: number) => head[i];
  if (head.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return 'image/png';
  // The header must be the very first thing in the file: a looser reading would let a page with "%PDF-" tucked inside it pass.
  if (head.length >= 5 && new TextDecoder('latin1').decode(head.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  return null;
}
