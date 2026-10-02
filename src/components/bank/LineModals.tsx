'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { bookBankExpense, ignoreBankLine, matchBankLine } from '@/app/actions/bank';
import { Chip } from '@/components/ui/Chip';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import type { BankLine, BookItem, ExpenseAccountOption } from '@/lib/bank-types';
import { compareDecimal } from '@/lib/decimal';
import { formatDate, inr2 } from '@/lib/format';

const lineAmount = (l: BankLine) => (compareDecimal(l.credit, '0.00', 2) === 1 ? l.credit : l.debit);
const isCredit = (l: BankLine) => compareDecimal(l.credit, '0.00', 2) === 1;

/** Pick the book entry this line is the bank's side of. Same-amount entries come first; the database refuses a different amount. */
export function MatchModal({ line, items, onClose }: { line: BankLine | null; items: BookItem[]; onClose: () => void }) {
  const t = useTranslations('bank');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const [cheque, setCheque] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!line) return [];
    const wantDirection = isCredit(line) ? 'in' : 'out';
    const amount = lineAmount(line);
    return items
      .filter((i) => i.direction === wantDirection)
      .map((i) => ({ item: i, same: compareDecimal(i.amount, amount, 2) === 0 }))
      .sort((a, b) => Number(b.same) - Number(a.same));
  }, [line, items]);

  function pick(entryId: string) {
    if (!line) return;
    setFailure(null);
    start(async () => {
      try {
        const res = await matchBankLine({ lineId: line.id, entryId });
        if (!res.ok) return setFailure(res.error);
        router.refresh();
        if (res.data.chequeToClear) return setCheque(t('chequeToClearNotice'));
        onClose();
      } catch {
        setFailure(t('failed'));
      }
    });
  }

  function close() {
    setFailure(null);
    setCheque(null);
    onClose();
  }

  return (
    <Modal open={line !== null} onClose={close} title={t('matchTitle')} closeLabel={tc('close')} dismissible={!pending}>
      {line && (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            {t('matchFor', { amount: inr2(lineAmount(line)), date: formatDate(line.txnDate) })}
          </p>
          {cheque && <p role="status" className="alert good">{cheque}</p>}
          {failure && <p role="alert" className="alert bad">{failure}</p>}
          {rows.length === 0 ? (
            <p className="muted">{t('matchEmpty')}</p>
          ) : (
            <ul className="pick-list" aria-label={t('matchTitle')}>
              {rows.map(({ item, same }) => (
                <li key={item.entryId} role="presentation">
                  <button type="button" className="pick-row" disabled={pending || !same || cheque !== null} onClick={() => pick(item.entryId)}>
                    <span className="pick-title">
                      <span className="num">{inr2(item.amount)}</span> · {formatDate(item.entryDate)} {item.entryNo ? <span className="mono">#{item.entryNo}</span> : null}{' '}
                      {same ? <Chip tone="good">{t('sameAmount')}</Chip> : <Chip tone="muted">{t('differentAmount')}</Chip>}
                    </span>
                    <span className="pick-sub">{[item.narration, item.instrumentNo].filter(Boolean).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="modal-actions">
            <button type="button" className="btn ghost" disabled={pending} onClick={close}>{cheque ? tc('close') : tc('cancel')}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** Book an unmatched debit as an expense paid from the bank (Bank Charges by default). */
export function ExpenseModal({ line, accounts, onClose }: { line: BankLine | null; accounts: ExpenseAccountOption[]; onClose: () => void }) {
  const tc = useTranslations('common');
  const t = useTranslations('bank');
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={line !== null} onClose={onClose} title={t('expenseTitle')} closeLabel={tc('close')} dismissible={!busy}>
      {line && <ExpenseForm line={line} accounts={accounts} onClose={onClose} onBusy={setBusy} />}
    </Modal>
  );
}

function ExpenseForm({ line, accounts, onClose, onBusy }: { line: BankLine; accounts: ExpenseAccountOption[]; onClose: () => void; onBusy: (b: boolean) => void }) {
  const t = useTranslations('bank');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [accountId, setAccountId] = useState(accounts.find((a) => a.isBankCharges)?.id ?? '');
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFailure(null);
    onBusy(true);
    start(async () => {
      try {
        // The database takes the date and amount from the stored line; only the line, the ledger and the note go.
        const res = await bookBankExpense({ lineId: line.id, accountId: accountId || undefined, note });
        if (!res.ok) return setFailure(res.error);
        router.refresh();
        onClose();
      } catch {
        setFailure(t('failed'));
      } finally {
        onBusy(false);
      }
    });
  }

  return (
    <form onSubmit={submit} noValidate>
      <p className="hint" style={{ marginTop: 0 }}>{t('expenseIntro', { amount: inr2(line.debit), date: formatDate(line.txnDate) })}</p>
      <p className="mono" style={{ overflowWrap: 'anywhere' }}>{line.narration}</p>
      <Field id="exp-account" label={t('expenseAccount')} hint={t('expenseNoGst')}>
        <select id="exp-account" value={accountId} disabled={pending} onChange={(e) => setAccountId(e.target.value)}>
          {!accounts.some((a) => a.isBankCharges) && <option value="">—</option>}
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
      <Field id="exp-note" label={t('expenseNote')}>
        <input id="exp-note" value={note} maxLength={120} disabled={pending} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
      </Field>
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" disabled={pending} onClick={onClose}>{tc('cancel')}</button>
        <button type="submit" className="btn primary" disabled={pending}>{pending ? t('expenseSaving') : t('expenseSubmit')}</button>
      </div>
    </form>
  );
}

/** Set a line aside with a reason. */
export function IgnoreModal({ line, onClose }: { line: BankLine | null; onClose: () => void }) {
  const t = useTranslations('bank');
  const tc = useTranslations('common');
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={line !== null} onClose={onClose} title={t('ignoreTitle')} closeLabel={tc('close')} dismissible={!busy}>
      {line && <IgnoreForm line={line} onClose={onClose} onBusy={setBusy} />}
    </Modal>
  );
}

function IgnoreForm({ line, onClose, onBusy }: { line: BankLine; onClose: () => void; onBusy: (b: boolean) => void }) {
  const t = useTranslations('bank');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFailure(null);
    if (!reason.trim()) return setFailure(te('validation.reason_required'));
    onBusy(true);
    start(async () => {
      try {
        const res = await ignoreBankLine({ lineId: line.id, reason });
        if (!res.ok) return setFailure(res.error);
        router.refresh();
        onClose();
      } catch {
        setFailure(t('failed'));
      } finally {
        onBusy(false);
      }
    });
  }

  return (
    <form onSubmit={submit} noValidate>
      <p className="hint" style={{ marginTop: 0 }}>{t('ignoreIntro', { amount: inr2(lineAmount(line)), date: formatDate(line.txnDate) })}</p>
      <Field id="ign-reason" label={t('ignoreReason')} hint={t('ignoreReasonHint')}>
        <input id="ign-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoComplete="off" autoFocus />
      </Field>
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" disabled={pending} onClick={onClose}>{tc('cancel')}</button>
        <button type="submit" className="btn primary" disabled={pending}>{pending ? tc('saving') : t('ignoreSubmit')}</button>
      </div>
    </form>
  );
}
