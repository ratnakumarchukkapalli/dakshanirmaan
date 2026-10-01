import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { formatDate, inr2 } from '@/lib/format';
import type { InvoiceNote } from '@/lib/notes-data';
import { NOTE_CONFIG } from '@/lib/notes-types';
import type { NoteKind } from '@/schemas/notes';

/**
 * The notes made against this invoice or bill, with the button to make a new one. `canWrite` is an
 * owner who has passed the authenticator step; a counter session only reads the list (and never sees
 * a draft, which is not its to open). `canMake` is false once the invoice is cancelled.
 */
export async function NotesCard({ kind, invoiceId, notes, canWrite, canMake }: { kind: NoteKind; invoiceId: string; notes: InvoiceNote[]; canWrite: boolean; canMake: boolean }) {
  const [t, tk] = await Promise.all([getTranslations('notes'), getTranslations(`notes.${kind}`)]);
  const cfg = NOTE_CONFIG[kind];
  const shown = canWrite ? notes : notes.filter((n) => n.status !== 'draft');
  if (shown.length === 0 && !(canWrite && canMake)) return null;
  const chip: Record<string, { tone: ChipTone; label: string }> = {
    posted: { tone: 'good', label: t('statusPosted') },
    draft: { tone: 'muted', label: t('statusDraft') },
    cancelled: { tone: 'bad', label: t('statusCancelled') },
  };
  return (
    <Card>
      <div className="cardtitle">
        <span>{tk('cardTitle')}</span>
        {canWrite && canMake && <Link href={`${cfg.base}/new?invoice=${invoiceId}`} className="btn ghost sm no-print">+ {tk('newNote')}</Link>}
      </div>
      {shown.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{tk('cardEmpty')}</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead><tr><th>{t('number')}</th><th>{t('noteDate')}</th><th>{t('status')}</th><th className="r">{t('total')}</th></tr></thead>
            <tbody>
              {shown.map((n) => {
                const draft = n.status === 'draft';
                const to = draft ? `${cfg.base}/${n.id}` : `${cfg.base}/${n.id}/view`;
                const c = chip[n.status] ?? chip.draft!;
                return (
                  <tr key={n.id}>
                    <td className="nowrap"><Link href={to} className="mono rownum">{draft ? t('draftNumber') : n.noteNo}</Link></td>
                    <td className="nowrap num">{formatDate(n.date)}</td>
                    <td><Chip tone={c.tone}>{c.label}</Chip></td>
                    <td className="r num">{draft ? '—' : inr2(n.grandTotal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
