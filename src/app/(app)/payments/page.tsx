import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { CashDepositList } from '@/components/cash/CashDepositList';
import { DepositCashButton } from '@/components/cash/DepositCashButton';
import { PaymentRowActions } from '@/components/payments/PaymentRowActions';
import { RowLink } from '@/components/sales/RowLink';
import { Card } from '@/components/ui/Card';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { SearchInput } from '@/components/ui/SearchInput';
import { Segmented } from '@/components/ui/Segmented';
import { StatTile } from '@/components/ui/StatTile';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { loadCashDeposits, loadCashOnHand } from '@/lib/cash-deposits-data';
import { formatDate, inr, inr2, todayIn } from '@/lib/format';
import { CHEQUE_LABEL, loadPaymentsList } from '@/lib/payments-data';
import { cleanSearchText } from '@/lib/search';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

type Segment = 'all' | 'receipt' | 'payment' | 'draft';
const STATUS_TONE: Record<string, ChipTone> = { draft: 'muted', posted: 'good', cancelled: 'bad' };

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const sp = await searchParams;
  const segment: Segment = sp.status === 'receipt' || sp.status === 'payment' || sp.status === 'draft' ? sp.status : 'all';
  const q = cleanSearchText(sp.q);

  const [t, ts, member, supabase, ctx] = await Promise.all([getTranslations('payments'), getTranslations('sales'), getCurrentMember(), createClient(), getShellContext()]);
  const isAdmin = isVerifiedAdmin(member);
  const today = todayIn(ctx.timeZone);
  const [deposits, cashOnHand] = await Promise.all([loadCashDeposits(supabase, { limit: 10 }), loadCashOnHand(supabase, today)]);

  const { rows, tiles } = await loadPaymentsList(supabase, {
    direction: segment === 'receipt' || segment === 'payment' ? segment : undefined,
    draftOnly: segment === 'draft',
    q: q || undefined,
  });

  const href = (s: Segment) => {
    const params = new URLSearchParams();
    if (s !== 'all') params.set('status', s);
    if (q) params.set('q', q);
    const qs = params.toString();
    return `/payments${qs ? `?${qs}` : ''}`;
  };

  return (
    <div className="screen">
      <div className="screenhead">
        <h1>{t('title')}</h1>
        <span className="sub">{t('subtitle')}</span>
        <span className="headbtns">
          <DepositCashButton today={today} cashOnHand={cashOnHand} />
          <Link href="/payments/new" className="btn primary">+ {t('newReceipt')}</Link>
        </span>
      </div>

      <div className="tiles">
        <StatTile label={t('tileReceivedToday')} value={inr(tiles.receivedToday)} />
        <StatTile label={t('tileChequesInHand')} value={inr(tiles.chequesInHand)} />
        <StatTile label={t('tileChequesIssued')} value={inr(tiles.chequesIssued)} />
        <StatTile label={t('tileUnallocated')} value={inr(tiles.unallocated)} />
      </div>

      <div className="toolbar">
        <Segmented
          label={t('segments')}
          active={segment}
          options={[
            { key: 'all', label: t('all'), href: href('all') },
            { key: 'receipt', label: t('receipts'), href: href('receipt') },
            { key: 'payment', label: t('outgoing'), href: href('payment') },
            { key: 'draft', label: t('drafts'), href: href('draft') },
          ]}
        />
        <SearchInput name="q" defaultValue={q} label={t('searchLabel')} placeholder={t('searchPlaceholder')} buttonLabel={t('searchButton')} keep={{ status: segment === 'all' ? undefined : segment }} />
      </div>

      <Card>
        {rows.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>{t('voucherCol')}</th><th>{t('modeCol')}</th><th className="r">{t('amountCol')}</th>
                  <th>{t('allocatedCol')}</th><th></th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const draft = r.status === 'draft';
                  // Cheque status is the more specific truth when there is one (bounce_cheque sets
                  // both status = 'cancelled' and cheque_status = 'bounced' together).
                  const statusChip = draft
                    ? { tone: STATUS_TONE.draft!, label: ts('statusDraft') }
                    : r.chequeStatus
                      ? { tone: r.chequeStatus === 'bounced' ? STATUS_TONE.cancelled! : r.chequeStatus === 'cleared' ? STATUS_TONE.posted! : STATUS_TONE.draft!, label: t(CHEQUE_LABEL[r.chequeStatus]!) }
                      : r.status === 'cancelled'
                        ? { tone: STATUS_TONE.cancelled!, label: ts('statusCancelled') }
                        : { tone: STATUS_TONE.posted!, label: ts('statusPosted') };
                  const modeRef = [r.instrumentNo, r.chequeBank].filter(Boolean).join(' · ') || undefined;
                  const cells = (
                    <>
                      <td className="nowrap">
                        {draft ? (
                          <Link href={`/payments/new?id=${r.id}`} className="mono rownum">{t('drafts')}</Link>
                        ) : (
                          <span className="mono rownum">{r.voucherNo}</span>
                        )}
                        <div className="sub num only-narrow">{formatDate(r.paymentDate)}</div>
                      </td>
                      <td className="nowrap">
                        {r.partyName}
                        <div className="sub mono">{modeRef ?? r.mode}</div>
                      </td>
                      <td className="r num"><b>{inr2(r.amount)}</b></td>
                      <td className="muted">{r.allocatedRefs.length ? r.allocatedRefs.join(', ') : t('onAccount')}</td>
                      <td><Chip tone={statusChip.tone}>{statusChip.label}</Chip></td>
                      <td>{!draft && r.status === 'posted' && <PaymentRowActions id={r.id} chequeStatus={r.chequeStatus} direction={r.direction} isAdmin={isAdmin} />}</td>
                    </>
                  );
                  // Only a draft opens anything (its edit form); a posted or cancelled payment has
                  // no view screen of its own — its status and cheque actions live on the row itself.
                  return draft ? <RowLink key={r.id} href={`/payments/new?id=${r.id}`}>{cells}</RowLink> : <tr key={r.id}>{cells}</tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CashDepositList rows={deposits} isAdmin={isAdmin} />
    </div>
  );
}
