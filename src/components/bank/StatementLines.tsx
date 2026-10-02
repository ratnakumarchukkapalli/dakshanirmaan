'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { autoMatchStatement, matchBankLine, unmatchBankLine } from '@/app/actions/bank';
import { markCleared } from '@/app/actions/payments';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import type { BankLine, BookItem, ExpenseAccountOption, LineStatus } from '@/lib/bank-types';
import { compareDecimal } from '@/lib/decimal';
import { formatDate, inr2 } from '@/lib/format';
import { ExpenseModal, IgnoreModal, MatchModal } from './LineModals';

const TONE: Record<LineStatus, ChipTone> = { matched: 'good', suggested: 'accent', unmatched: 'warn', ignored: 'muted' };
const hasAmount = (v: string) => compareDecimal(v, '0.00', 2) === 1;

interface Props {
  statementId: string;
  lines: BankLine[];
  bookItems: BookItem[];
  expenseAccounts: ExpenseAccountOption[];
  /** Whether the statement has any line the auto-matcher could still take. */
  canAutoMatch: boolean;
}

/** The statement's lines with per-line actions, and the Auto-match button. Rows stack as cards on a phone. */
export function StatementLines({ statementId, lines, bookItems, expenseAccounts, canAutoMatch }: Props) {
  const t = useTranslations('bank');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<{ kind: 'match' | 'expense' | 'ignore'; line: BankLine } | null>(null);
  const close = () => setModal(null);

  function run(work: () => Promise<{ ok: true } | { ok: false; error: string }>, done?: string) {
    setFailure(null);
    setNotice(null);
    start(async () => {
      try {
        const res = await work();
        if (!res.ok) return setFailure(res.error);
        if (done) setNotice(done);
        router.refresh();
      } catch {
        setFailure(t('failed'));
      }
    });
  }

  function autoMatch() {
    setFailure(null);
    setNotice(null);
    start(async () => {
      try {
        const res = await autoMatchStatement({ statementId });
        if (!res.ok) return setFailure(res.error);
        setNotice(res.data.matched === 0 ? t('autoNone') : t('autoDone', { n: res.data.matched }));
        router.refresh();
      } catch {
        setFailure(t('failed'));
      }
    });
  }

  return (
    <>
      <div className="toolbar">
        <button type="button" className="btn primary" disabled={pending || !canAutoMatch} onClick={autoMatch}>{pending ? t('working') : t('autoMatch')}</button>
        <span className="hint" style={{ margin: 0 }}>{t('autoHint')}</span>
      </div>
      <div aria-live="polite">
        {failure && <p role="alert" className="alert bad">{failure}</p>}
        {notice && <p role="status" className="alert good">{notice}</p>}
      </div>

      {lines.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{t('linesEmpty')}</p>
      ) : (
        <div className="tablewrap">
          <table className="stacktable">
            <thead>
              <tr>
                <th>{t('colDate')}</th>
                <th>{t('colNarration')}</th>
                <th className="r">{t('colOut')}</th>
                <th className="r">{t('colIn')}</th>
                <th className="r">{t('colBalance')}</th>
                <th>{t('colStatus')}</th>
                <th>{t('colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const credit = hasAmount(l.credit);
                return (
                  <tr key={l.id}>
                    <td className="nowrap" data-label={t('colDate')}>{formatDate(l.txnDate)}</td>
                    <td className="wide" data-label={t('colNarration')} style={{ overflowWrap: 'anywhere' }}>
                      {l.narration}
                      {l.reference && <div className="mono muted">{l.reference}</div>}
                      {l.suggestion && (
                        <div className="hint" style={{ margin: '4px 0 0' }}>
                          {t('suggested', {
                            kind: t.has(`kind.${l.suggestion.kind}`) ? t(`kind.${l.suggestion.kind}`) : l.suggestion.kind,
                            no: l.suggestion.entryNo ?? '—', date: formatDate(l.suggestion.entryDate),
                          })}
                        </div>
                      )}
                      {l.ignoreReason && <div className="hint" style={{ margin: '4px 0 0' }}>{t('ignoredReason', { reason: l.ignoreReason })}</div>}
                    </td>
                    <td className="r num" data-label={t('colOut')}>{hasAmount(l.debit) ? inr2(l.debit) : ''}</td>
                    <td className="r num" data-label={t('colIn')}>{credit ? inr2(l.credit) : ''}</td>
                    <td className="r num" data-label={t('colBalance')}>{l.balance === null ? '' : inr2(l.balance)}</td>
                    <td data-label={t('colStatus')}><Chip tone={TONE[l.status]}>{t(`status.${l.status}`)}</Chip></td>
                    <td className="actions" data-label={t('colActions')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {(l.status === 'unmatched' || l.status === 'suggested') && (
                          <>
                            {l.suggestion && (
                              <button type="button" className="btn primary sm" disabled={pending} onClick={() => run(() => matchBankLine({ lineId: l.id, entryId: l.suggestion!.entryId }))}>{t('accept')}</button>
                            )}
                            <button type="button" className="btn ghost sm" disabled={pending} onClick={() => setModal({ kind: 'match', line: l })}>{t('matchBtn')}</button>
                            {credit ? (
                              <Link className="btn ghost sm" href={`/payments/new?bankLine=${l.id}`}>{t('createReceipt')}</Link>
                            ) : (
                              <>
                                <button type="button" className="btn ghost sm" disabled={pending} onClick={() => setModal({ kind: 'expense', line: l })}>{t('createExpense')}</button>
                                <Link className="btn ghost sm" href={`/payments/new?bankLine=${l.id}&direction=payment`}>{t('createPayment')}</Link>
                              </>
                            )}
                            <button type="button" className="btn ghost sm" disabled={pending} onClick={() => setModal({ kind: 'ignore', line: l })}>{t('ignoreBtn')}</button>
                          </>
                        )}
                        {l.status === 'matched' && (
                          <>
                            {l.chequeToClear && l.matchedPaymentId && (
                              <button type="button" className="btn primary sm" disabled={pending} onClick={() => run(() => markCleared({ id: l.matchedPaymentId! }), t('chequeCleared'))}>{t('markCleared')}</button>
                            )}
                            <button type="button" className="btn ghost sm" disabled={pending} onClick={() => run(() => unmatchBankLine({ lineId: l.id }))}>{t('unmatchBtn')}</button>
                          </>
                        )}
                        {l.status === 'ignored' && (
                          <button type="button" className="btn ghost sm" disabled={pending} onClick={() => run(() => unmatchBankLine({ lineId: l.id }))}>{t('unignoreBtn')}</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <MatchModal line={modal?.kind === 'match' ? modal.line : null} items={bookItems} onClose={close} />
      <ExpenseModal line={modal?.kind === 'expense' ? modal.line : null} accounts={expenseAccounts} onClose={close} />
      <IgnoreModal line={modal?.kind === 'ignore' ? modal.line : null} onClose={close} />
    </>
  );
}
