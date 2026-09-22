'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { convertChallanToInvoice } from '@/app/actions/challans';
import { Card } from '@/components/ui/Card';
import { formatDate, inr2 } from '@/lib/format';
import type { OpenChallan } from '@/lib/sales-types';

/**
 * Posted challans nobody has invoiced yet. "Invoice ->" starts (or resumes) that invoice:
 * `convertChallanToInvoice` is idempotent, so a slow network or a double click never creates a
 * second draft — the person always lands on the one draft this challan already has.
 */
export function OpenChallansPanel({ challans }: { challans: OpenChallan[] }) {
  const t = useTranslations('challans');
  const ts = useTranslations('sales');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  function convert(id: string) {
    setFailure(null);
    setBusyId(id);
    start(async () => {
      const res = await convertChallanToInvoice({ id });
      setBusyId(null);
      if (!res.ok) return setFailure(res.error);
      router.push(`/sales/${res.data.id}`);
    });
  }

  return (
    <Card>
      <div className="cardtitle">{t('openChallans')}</div>
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      {challans.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{t('noOpenChallans')}</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th>{t('dc')}</th><th>{ts('party')}</th><th className="r">{t('value')}</th><th></th></tr>
            </thead>
            <tbody>
              {challans.map((c) => (
                <tr key={c.id}>
                  <td className="nowrap">
                    <span className="mono rownum">{c.challanNo}</span>
                    <div className="sub num only-narrow">{formatDate(c.challanDate)}</div>
                  </td>
                  <td>{c.partyName}</td>
                  <td className="r num">{inr2(c.value)}</td>
                  <td>
                    <button type="button" className="btn ghost sm" disabled={pending} onClick={() => convert(c.id)}>
                      {busyId === c.id ? t('converting') : t('invoiceArrow')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint" style={{ marginTop: 10 }}>{t('openChallansNote')}</p>
    </Card>
  );
}
