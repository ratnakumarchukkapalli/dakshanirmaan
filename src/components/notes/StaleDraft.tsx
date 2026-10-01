'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteDraftNote } from '@/app/actions/notes';
import { NOTE_CONFIG } from '@/lib/notes-types';
import type { NoteKind } from '@/schemas/notes';

/** A draft whose invoice or bill was cancelled after it was saved: it can no longer be posted, only thrown away. */
export function StaleDraft({ kind, id, invoiceId }: { kind: NoteKind; id: string; invoiceId: string }) {
  const t = useTranslations('notes');
  const router = useRouter();
  const cfg = NOTE_CONFIG[kind];
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const remove = () =>
    start(async () => {
      setError(null);
      const res = await deleteDraftNote({ kind, id });
      if (!res.ok) return setError(res.error);
      router.push(`${cfg.invoiceBase}/${invoiceId}/view`);
    });

  return (
    <div className="screen stack">
      <div className="screenhead" style={{ marginBottom: 0 }}>
        <Link href={`${cfg.invoiceBase}/${invoiceId}/view`} className="btn ghost sm">{t('staleBack')}</Link>
        <h1>{t('staleTitle')}</h1>
      </div>
      <p role="status" className="alert warn">{t('staleBody')}</p>
      {error && <p role="alert" className="alert bad">{error}</p>}
      <div>
        <button type="button" className="btn danger" disabled={pending} onClick={remove}>{t('deleteConfirm')}</button>
      </div>
    </div>
  );
}
