import { getTranslations } from 'next-intl/server';
import { Chip } from '@/components/ui/Chip';
import { StatTile } from '@/components/ui/StatTile';
import type { ReconSummary } from '@/lib/bank-types';
import { signOf } from '@/lib/decimal';
import { formatDate, inr2 } from '@/lib/format';

/** Bank balance, book balance, difference and unmatched lines, with whether the difference is explained by what is on the screen. */
export async function ReconTiles({ recon, unmatchedLines }: { recon: ReconSummary | null; unmatchedLines?: number }) {
  const t = await getTranslations('bank');
  if (!recon || recon.bankBalance === null) {
    return <p className="hint" style={{ margin: '0 0 14px' }}>{t('noStatementYet')}</p>;
  }
  const sub = recon.asAt ? t('asAt', { date: formatDate(recon.asAt) }) : undefined;
  // "Reconciled" only when nothing is left to look at. `explained` alone says only that the bank lines are
  // continuous; an opening gap, a book-only entry or a bank-only line each still needs the owner's eye.
  const itemsToReview = recon.bookOnlyEntries + recon.bankOnlyLines;
  const openingGap = recon.openingDifference !== null && signOf(recon.openingDifference) !== 0;
  const gap = recon.unexplained !== null && signOf(recon.unexplained) !== 0;
  // An unknown opening difference (null) is never "reconciled".
  const reconciled = recon.explained === true && !gap && recon.openingDifference !== null && !openingGap && itemsToReview === 0;
  const verdict = reconciled ? (
    <Chip tone="good">{t('reconciled')}</Chip>
  ) : gap ? (
    <Chip tone="bad">{t('unexplained', { amount: inr2(recon.unexplained ?? '0.00') })}</Chip>
  ) : itemsToReview > 0 ? (
    <Chip tone="warn">{t('itemsToReview', { n: itemsToReview })}</Chip>
  ) : openingGap ? (
    <Chip tone="warn">{t('openingGap', { amount: inr2(recon.openingDifference ?? '0.00') })}</Chip>
  ) : (
    <Chip tone="warn">{t('needsReview')}</Chip>
  );
  return (
    <div className="tiles">
      <StatTile label={t('tileBank')} value={inr2(recon.bankBalance)} sub={sub} small />
      <StatTile label={t('tileBook')} value={inr2(recon.bookBalance)} sub={sub} small />
      <StatTile
        label={t('tileDifference')} value={inr2(recon.difference ?? '0.00')} small
        tone={recon.difference !== null && signOf(recon.difference) !== 0 ? 'warn' : 'good'}
        sub={verdict}
      />
      <StatTile label={t('tileUnmatched')} value={String(unmatchedLines ?? recon.unmatchedLines)} small tone={(unmatchedLines ?? recon.unmatchedLines) > 0 ? 'warn' : 'good'} />
    </div>
  );
}
