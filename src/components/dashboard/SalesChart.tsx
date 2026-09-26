'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { barShare, hasSales, maxTotal, type Category, type SalesDay } from '@/lib/dashboard-math';
import { signOf } from '@/lib/decimal';
import { formatDate, inr, inr2 } from '@/lib/format';

const ORDER: Category[] = ['cement', 'steel', 'other'];

interface Tip { index: number; left: number; top: number; align: 'start' | 'center' | 'end' }

/**
 * Sales of the last seven days, stacked by item category (the only client component on the
 * dashboard: it needs hover and focus state). Colours are the validated steel / cement chart
 * tokens; "other" is a neutral, present only in the legend when something else was sold.
 * Every number in the tooltip is also in the table view underneath, and each day is a focus
 * stop that shows the same tooltip as hover.
 */
export function SalesChart({ days }: { days: SalesDay[] }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const plotRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  const weekday = (iso: string, style: 'short' | 'long') =>
    new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  const catLabel = (c: Category) => t(`cat.${c}`);

  if (!hasSales(days)) {
    return <p className="muted chart-empty">{t('chartEmpty')}</p>;
  }

  const max = maxTotal(days);
  const usedCats = ORDER.filter((c) => days.some((d) => signOf(d[c]) !== 0));
  const showRoundOff = days.some((d) => signOf(d.roundOff) !== 0);
  const last = days.length - 1;

  const show = (index: number, el: HTMLElement) => {
    const share = barShare(days[index]!.total, max);
    const align: Tip['align'] = index < 2 ? 'start' : index >= last - 1 ? 'end' : 'center';
    const left = align === 'start' ? el.offsetLeft : align === 'end' ? el.offsetLeft + el.offsetWidth : el.offsetLeft + el.offsetWidth / 2;
    setTip({ index, left, top: el.offsetTop + el.offsetHeight * (1 - share), align });
  };
  const active = tip ? days[tip.index]! : null;

  return (
    <div className="chart">
      <ul className="legend" aria-label={t('legend')}>
        {usedCats.map((c) => (
          <li key={c}>
            <span className={`sw ${c}`} aria-hidden="true" />
            {catLabel(c)}
          </li>
        ))}
      </ul>

      <div className="plot-wrap">
        <div className="plot" ref={plotRef} role="group" aria-label={t('chartLabel')} onMouseLeave={() => setTip(null)}>
          {days.map((d, i) => {
            const parts = usedCats.filter((c) => signOf(d[c]) !== 0);
            const summary = [
              t('chartDay', { day: `${weekday(d.date, 'long')} ${formatDate(d.date)}`, total: inr(d.total) }),
              ...parts.map((c) => `${catLabel(c)} ${inr(d[c])}`),
            ].join(', ');
            return (
              <div
                key={d.date}
                className="col"
                tabIndex={0}
                role="img"
                aria-label={summary}
                onMouseEnter={(e) => show(i, e.currentTarget)}
                onFocus={(e) => show(i, e.currentTarget)}
                onBlur={() => setTip(null)}
                onKeyDown={(e) => { if (e.key === 'Escape') setTip(null); }}
              >
                {parts.map((c, k) => (
                  <div
                    key={c}
                    className={`bar ${c}${k === parts.length - 1 ? ' top' : ''}`}
                    style={{ height: `${barShare(d[c], max) * 100}%` }}
                  />
                ))}
              </div>
            );
          })}
          {tip && active && (
            <div className={`tooltip ${tip.align}`} style={{ left: tip.left, top: tip.top }} aria-hidden="true">
              <div className="tt-head">
                {weekday(active.date, 'short')} {formatDate(active.date)}
              </div>
              <div className="tt-total num">{inr(active.total)}</div>
              {usedCats.map((c) => (
                <div key={c} className="tt-row">
                  <span className={`key ${c}`} />
                  <span className="tt-name">{catLabel(c)}</span>
                  <span className="num">{inr(active[c])}</span>
                </div>
              ))}
              {signOf(active.roundOff) !== 0 && (
                <div className="tt-row">
                  <span className="key none" />
                  <span className="tt-name">{t('roundOff')}</span>
                  <span className="num">{inr2(active.roundOff)}</span>
                </div>
              )}
              <div className="tt-sub">{t('invoiceCount', { count: active.invoices })}</div>
            </div>
          )}
        </div>
        <div className="xlabels" aria-hidden="true">
          {days.map((d, i) => (
            <span key={d.date} className={i === last ? 'today' : undefined}>
              {weekday(d.date, 'short')}
            </span>
          ))}
        </div>
      </div>

      <details className="chart-table">
        <summary>{t('viewAsTable')}</summary>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>{t('col.date')}</th>
                {usedCats.map((c) => (
                  <th key={c} className="r">{catLabel(c)}</th>
                ))}
                {showRoundOff && <th className="r">{t('roundOff')}</th>}
                <th className="r">{t('col.total')}</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}>
                  <td className="nowrap num">{formatDate(d.date)}</td>
                  {usedCats.map((c) => (
                    <td key={c} className="r num">{inr(d[c])}</td>
                  ))}
                  {showRoundOff && <td className="r num">{inr2(d.roundOff)}</td>}
                  <td className="r num"><b>{inr(d.total)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
