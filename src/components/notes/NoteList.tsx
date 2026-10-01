import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { RowLink } from '@/components/sales/RowLink';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { rows } from '@/lib/db';
import { formatDate, inr2 } from '@/lib/format';
import { NOTE_CONFIG } from '@/lib/notes-types';
import { containsPattern, quoteFilterValue } from '@/lib/search';
import { createClient } from '@/lib/supabase/server';
import type { NoteKind } from '@/schemas/notes';

const LIMIT = 200;

/**
 * The notes segment of the sales ("Credit notes") and purchases ("Debit notes") lists. Drafts are an
 * owner's to see and open; a counter session reads posted and cancelled notes only.
 */
export async function NoteList({ kind, q, isOwner }: { kind: NoteKind; q: string; isOwner: boolean }) {
  const cfg = NOTE_CONFIG[kind];
  const [t, tk, supabase] = await Promise.all([getTranslations('notes'), getTranslations(`notes.${kind}`), createClient()]);
  let query = supabase.from(cfg.note).select('id, note_no, note_date, status, grand_total, party:parties(name)')
    .order('note_date', { ascending: false }).order('created_at', { ascending: false }).limit(LIMIT);
  if (!isOwner) query = query.neq('status', 'draft');
  if (q) {
    const pattern = quoteFilterValue(containsPattern(q));
    const matchRes = await supabase.from('parties').select('id').ilike('name', containsPattern(q)).limit(200);
    const ids = rows<{ id: string }>(matchRes, 'party search').map((p) => p.id);
    query = query.or([`note_no.ilike.${pattern}`, ...(ids.length ? [`party_id.in.(${ids.join(',')})`] : [])].join(','));
  }
  const list = rows<{ id: string; note_no: string | null; note_date: string; status: string; grand_total: number; party: { name: string } | null }>(await query, 'notes list');
  const chip: Record<string, { tone: ChipTone; label: string }> = {
    posted: { tone: 'good', label: t('statusPosted') },
    draft: { tone: 'muted', label: t('statusDraft') },
    cancelled: { tone: 'bad', label: t('statusCancelled') },
  };

  if (list.length === 0) return <p className="muted" style={{ margin: 0 }}>{q ? t('emptyFiltered') : tk('empty')}</p>;
  return (
    <>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>{t('number')}</th><th className="hide-narrow">{t('noteDate')}</th><th>{tk('party')}</th><th className="hide-narrow">{t('status')}</th><th className="r">{t('total')}</th></tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const draft = r.status === 'draft';
              const to = draft ? `${cfg.base}/${r.id}` : `${cfg.base}/${r.id}/view`;
              const c = chip[r.status] ?? chip.draft!;
              return (
                <RowLink key={r.id} href={to}>
                  <td className="nowrap">
                    <Link href={to} className="mono rownum">{draft ? t('draftNumber') : r.note_no}</Link>
                    <div className="sub num only-narrow">{formatDate(r.note_date)}</div>
                  </td>
                  <td className="nowrap num hide-narrow">{formatDate(r.note_date)}</td>
                  <td>
                    {r.party?.name ?? '—'}
                    <div className="only-narrow"><Chip tone={c.tone}>{c.label}</Chip></div>
                  </td>
                  <td className="hide-narrow"><Chip tone={c.tone}>{c.label}</Chip></td>
                  <td className="r num">{draft ? '—' : inr2(r.grand_total)}</td>
                </RowLink>
              );
            })}
          </tbody>
        </table>
      </div>
      {list.length >= LIMIT && <p className="hint">{t('limitNote', { n: LIMIT })}</p>}
    </>
  );
}
