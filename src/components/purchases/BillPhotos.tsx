'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { createAttachmentUpload, deleteAttachment, recordAttachment } from '@/app/actions/attachments';
import { Card } from '@/components/ui/Card';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIMES, type AttachmentMime } from '@/lib/attachments';
import { createClient } from '@/lib/supabase/client';

export interface BillPhoto { id: string; mime: string; bytes: number }

interface Props {
  billId: string | null;
  photos: BillPhoto[];
  /** Only a draft's photos can be removed; a posted or cancelled bill keeps them as evidence (the database refuses the removal). */
  canRemove: boolean;
  /** A cancelled bill takes no new files. */
  canAdd: boolean;
}

// A phone photo is often 4-8 MB: shrink it before it leaves the phone. Anything already small stays as it is.
const LONG_EDGE = 2200;
const KEEP_BELOW = 2 * 1024 * 1024;

async function prepare(file: File): Promise<{ blob: Blob; mime: AttachmentMime } | null> {
  if (file.type === 'application/pdf') return { blob: file, mime: 'application/pdf' };
  if (!file.type.startsWith('image/')) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  const asIs = (file.type === 'image/jpeg' || file.type === 'image/png') && file.size <= KEEP_BELOW && Math.max(bitmap.width, bitmap.height) <= LONG_EDGE;
  if (asIs) {
    bitmap.close();
    return { blob: file, mime: file.type as AttachmentMime };
  }
  const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return blob ? { blob, mime: 'image/jpeg' } : null;
}

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The bill's photo(s): take one with the phone camera or choose a photo / PDF. Files go straight to private storage. */
export function BillPhotos({ billId, photos: initial, canRemove, canAdd }: Props) {
  const t = useTranslations('purchases.photos');
  const te = useTranslations('errors');
  const router = useRouter();
  // Kept locally so a bill saved a moment ago on the "new bill" route (whose server page knows no photos) still shows what was just added.
  const [photos, setPhotos] = useState(initial);
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    // The server sent a fresh list (after a refresh): take it.
    setSeen(initial);
    setPhotos(initial);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  async function upload(file: File | undefined) {
    if (!file || !billId) return;
    setError(null);
    setBusy(true);
    try {
      const ready = await prepare(file);
      if (!ready) return setError(te('field.attachment_type_invalid'));
      if (ready.blob.size > ATTACHMENT_MAX_BYTES) return setError(te('field.attachment_too_big'));
      const mime = ready.mime;
      if (!ATTACHMENT_MIMES.includes(mime)) return setError(te('field.attachment_type_invalid'));

      const slot = await createAttachmentUpload({ entity: 'purchase_invoice', entityId: billId, mime, bytes: ready.blob.size });
      if (!slot.ok) return setError(slot.error);
      const stored = await createClient().storage.from('docs').uploadToSignedUrl(slot.data.path, slot.data.token, ready.blob, { contentType: mime });
      if (stored.error) return setError(t('uploadFailed'));
      const saved = await recordAttachment({ entity: 'purchase_invoice', entityId: billId, mime, bytes: ready.blob.size, path: slot.data.path });
      if (!saved.ok) return setError(saved.error);
      setPhotos((list) => [...list, { id: saved.data.id, mime: saved.data.mime, bytes: saved.data.bytes }]);
      router.refresh();
    } finally {
      setBusy(false);
      if (camera.current) camera.current.value = '';
      if (picker.current) picker.current.value = '';
    }
  }

  const remove = (id: string) =>
    start(async () => {
      setError(null);
      const res = await deleteAttachment({ id });
      setAsking(null);
      if (!res.ok) return setError(res.error);
      setPhotos((list) => list.filter((p) => p.id !== id));
      router.refresh();
    });

  return (
    <Card>
      <div className="cardtitle"><span>{t('title')}</span></div>
      {!billId && <p className="hint">{t('saveFirst')}</p>}
      {billId && photos.length === 0 && <p className="hint">{t('none')}</p>}
      {error && <p role="alert" className="alert bad">{error}</p>}

      {photos.length > 0 && (
        <ul className="photos" style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {photos.map((p, i) => (
            <li key={p.id} style={{ display: 'grid', gap: 6, width: 132 }}>
              <a href={`/api/attachments/${p.id}`} target="_blank" rel="noopener noreferrer" aria-label={t('open', { n: i + 1 })}>
                {p.mime === 'application/pdf' ? (
                  <span style={{ display: 'grid', placeItems: 'center', width: 132, height: 96, borderRadius: 'var(--r-inner)', background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 700 }}>PDF</span>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- a private file behind a redirect to a signed address
                  <img src={`/api/attachments/${p.id}`} alt={t('alt', { n: i + 1 })} loading="lazy" style={{ width: 132, height: 96, objectFit: 'cover', borderRadius: 'var(--r-inner)' }} />
                )}
              </a>
              <span className="sub">{sizeText(p.bytes)}</span>
              {canRemove && (asking === p.id ? (
                <span style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn danger sm" disabled={pending} onClick={() => remove(p.id)}>{t('removeYes')}</button>
                  <button type="button" className="btn ghost sm" onClick={() => setAsking(null)}>{t('removeNo')}</button>
                </span>
              ) : (
                <button type="button" className="btn ghost sm" onClick={() => setAsking(p.id)}>{t('remove', { n: i + 1 })}</button>
              ))}
            </li>
          ))}
        </ul>
      )}

      {billId && canAdd && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => upload(e.target.files?.[0])} />
          <input ref={picker} type="file" accept="image/jpeg,image/png,application/pdf" hidden onChange={(e) => upload(e.target.files?.[0])} />
          <button type="button" className="btn ghost" disabled={busy} onClick={() => camera.current?.click()}>{busy ? t('uploading') : t('take')}</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => picker.current?.click()}>{t('choose')}</button>
        </div>
      )}
      {billId && canAdd && <p className="hint">{t('hint')}</p>}
      {billId && !canRemove && photos.length > 0 && <p className="hint">{t('keptAsEvidence')}</p>}
      {billId && !canAdd && <p className="hint">{t('cancelledNoAdd')}</p>}
    </Card>
  );
}
