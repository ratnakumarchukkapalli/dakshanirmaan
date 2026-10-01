import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { LedgerTable } from '@/components/ui/LedgerTable';
import type { CashDepositRow } from '@/lib/cash-deposits-data';
import { formatDate, inr2 } from '@/lib/format';
import { CancelCashDeposit } from './CancelCashDeposit';

/** Cash deposits as a short ledger. Only an owner sees Cancel (the database is owner-only too). */
export async function CashDepositList({ rows, isAdmin, action }: { rows: CashDepositRow[]; isAdmin: boolean; action?: ReactNode }) {
  const t = await getTranslations('cashDeposit');
  return (
    <Card>
      <div className="cardtitle">{t('listTitle')}</div>
      {action && <div style={{ marginBottom: 12 }}>{action}</div>}
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{t('listEmpty')}</p>
      ) : (
        <LedgerTable
          columns={[
            { header: t('colDate'), nowrap: true },
            { header: t('colAmount'), numeric: true },
            { header: t('colRef') },
            { header: '' },
          ]}
          rows={rows.map((r) => ({
            key: r.id,
            cells: [
              formatDate(r.depositDate),
              inr2(r.amount),
              [r.reference, r.note].filter(Boolean).join(' · ') || '—',
              r.status === 'cancelled' ? <Chip tone="bad">{t('statusCancelled')}</Chip> : isAdmin ? <CancelCashDeposit id={r.id} /> : null,
            ],
          }))}
        />
      )}
    </Card>
  );
}
