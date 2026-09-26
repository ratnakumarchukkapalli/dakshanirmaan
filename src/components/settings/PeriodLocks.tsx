'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createFiscalYear, setPeriodLock } from '@/app/actions/periods';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Field } from '@/components/ui/Field';

export interface PeriodRow { month: string; yearLabel: string; isLocked: boolean; drafts: number }

const monthName = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

/** Owner-only: lock a month once its return is filed, unlock it with a reason, create the next financial year. */
export function PeriodLocks({ periods, nextYear }: { periods: PeriodRow[]; nextYear: string | null }) {
  const t = useTranslations('settings.periods');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const change = (month: string, locked: boolean) => {
    setFailure(null);
    setNotice(null);
    start(async () => {
      const res = await setPeriodLock({ month, locked, reason: locked ? undefined : reason });
      if (!res.ok) return setFailure(res.error);
      setNotice(t(locked ? 'locked_done' : 'unlocked_done', { month: monthName(month) }));
      setUnlocking(null);
      setReason('');
      router.refresh();
    });
  };

  const create = () => {
    if (!nextYear) return;
    setFailure(null);
    setNotice(null);
    start(async () => {
      const res = await createFiscalYear({ label: nextYear });
      if (!res.ok) return setFailure(res.error);
      setNotice(t(res.data.added > 0 ? 'created' : 'createdNone', { label: nextYear }));
      router.refresh();
    });
  };

  return (
    <div className="stack">
      <p className="hint" style={{ margin: 0 }}>{t('hint')}</p>
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      {notice && <p role="status" className="alert good">{notice}</p>}
      <Card>
        {periods.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead><tr><th>{t('colMonth')}</th><th>{t('colStatus')}</th><th className="r">{t('colDrafts')}</th><th /></tr></thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.month}>
                    <td>{monthName(p.month)} <span className="sub">{p.yearLabel}</span></td>
                    <td><Chip tone={p.isLocked ? 'warn' : 'good'}>{p.isLocked ? t('locked') : t('open')}</Chip></td>
                    <td className="r num">{p.drafts}</td>
                    <td>
                      {p.isLocked ? (
                        unlocking === p.month ? (
                          <div className="fieldrow" style={{ justifyContent: 'flex-end' }}>
                            <Field id={`reason-${p.month}`} label={t('reason')}>
                              <input id={`reason-${p.month}`} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
                            </Field>
                            <button type="button" className="btn danger sm" disabled={pending || reason.trim().length < 3} onClick={() => change(p.month, false)}>{t('confirmUnlock')}</button>
                            <button type="button" className="btn ghost sm" onClick={() => { setUnlocking(null); setReason(''); }}>{t('cancel')}</button>
                          </div>
                        ) : (
                          <button type="button" className="btn ghost sm" disabled={pending} onClick={() => setUnlocking(p.month)}>{t('unlock')}</button>
                        )
                      ) : (
                        <button type="button" className="btn primary sm" disabled={pending} onClick={() => change(p.month, true)}>{t('lock')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {nextYear && (
        <Card>
          <div className="cardtitle">{t('createTitle')}</div>
          <p className="hint">{t('createHint')}</p>
          <button type="button" className="btn primary" disabled={pending} onClick={create}>{t('createBtn', { label: nextYear })}</button>
        </Card>
      )}
    </div>
  );
}
