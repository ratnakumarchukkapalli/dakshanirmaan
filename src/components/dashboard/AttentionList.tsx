import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { attentionHref, type AttentionRow } from '@/lib/dashboard-math';
import { signOf } from '@/lib/decimal';
import { inr, inr2 } from '@/lib/format';

export const ATTENTION_LIMIT = 10;
const TONE: Record<string, ChipTone> = { critical: 'bad', warning: 'warn', info: 'accent' };
const SEVERITIES = ['critical', 'warning', 'info'] as const;

/**
 * The `v_attention` feed, most urgent first. The title and detail are the database's own
 * (English) sentences; the severity chip, the amounts and the layout are localised. Each row is a
 * real link, so Tab reaches it and Enter opens it.
 */
export async function AttentionList({ rows }: { rows: AttentionRow[] }) {
  const t = await getTranslations('dashboard.attention');
  if (rows.length === 0) return <p className="dash-empty">{t('empty')}</p>;
  const shown = rows.slice(0, ATTENTION_LIMIT);
  return (
    <>
      <ul className="alist">
        {shown.map((r, i) => {
          const href = attentionHref(r.kind, r.subject_id);
          const severity = (SEVERITIES as readonly string[]).includes(r.severity) ? r.severity : 'info';
          const money = r.kind === 'day_close_difference' ? inr2 : inr;
          const body = (
            <>
              <span className={`dot ${severity}`} aria-hidden="true" />
              <span className="abody">
                <span className="t">{r.title}</span>
                <span className="d">{r.detail}</span>
              </span>
              <span className="aside">
                <Chip tone={TONE[severity]}>{t(`severity.${severity as (typeof SEVERITIES)[number]}`)}</Chip>
                {r.amount !== null && <span className="num">{money(r.amount)}</span>}
                {r.interest !== null && signOf(String(r.interest)) === 1 && (
                  <span className="sub">{t('interest', { amount: inr(r.interest) })}</span>
                )}
              </span>
            </>
          );
          return (
            <li key={`${r.kind}-${r.subject_id ?? i}`}>
              {href ? <Link href={href} className="aitem">{body}</Link> : <div className="aitem">{body}</div>}
            </li>
          );
        })}
      </ul>
      {rows.length > shown.length && <p className="alist-more">{t('more', { count: rows.length - shown.length })}</p>}
    </>
  );
}
