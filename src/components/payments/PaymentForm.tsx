'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { postPayment, saveDraftPayment } from '@/app/actions/payments';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { DateField } from '@/components/ui/DateField';
import { Field } from '@/components/ui/Field';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { Modal } from '@/components/ui/Modal';
import { Picker, type PickerOption } from '@/components/ui/Picker';
import type { ErrorCode } from '@/lib/action-result';
import { addDecimal, compareDecimal } from '@/lib/decimal';
import { inr, inr2 } from '@/lib/format';
import { autoAllocateOldestFirst } from '@/lib/payments-alloc';
import type { FormAccount, PaymentFormContext, PaymentFormInitial, PaymentFormValues } from '@/lib/payments-types';
import { PAYMENT_MODES, saveDraftPaymentSchema } from '@/schemas/payments';
import { AllocationGrid } from './AllocationGrid';

interface Props {
  ctx: PaymentFormContext;
  /** Present when editing an existing draft. */
  initial?: PaymentFormInitial;
}

/**
 * One plain `.bill` layout (main card + floating summary), same shape as the invoice form. The
 * Pay direction and the discount field are rendered only for a verified admin session — the same
 * things `post_payment` itself refuses from anyone else, so the form never offers what the
 * database will reject.
 */
export function PaymentForm({ ctx, initial }: Props) {
  const t = useTranslations('payments');
  const ts = useTranslations('sales');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draftId, setDraftId] = useState<string | null>(initial?.id ?? null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(initial?.updatedAt ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; code?: ErrorCode } | null>(null);
  const [confirm, setConfirm] = useState<null | 'post'>(null);
  const [allocations, setAllocations] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const a of initial?.values.allocations ?? []) out[a.invoiceId] = a.amount;
    return out;
  });
  const alertRef = useRef<HTMLDivElement>(null);

  const partiesById = useMemo(() => new Map(ctx.parties.map((p) => [p.id, p])), [ctx.parties]);

  const { register, handleSubmit, control, setValue, getValues, trigger, reset, formState: { errors } } = useForm<PaymentFormValues>({
    resolver: zodResolver(saveDraftPaymentSchema) as unknown as Resolver<PaymentFormValues>,
    defaultValues: initial?.values ?? {
      direction: 'receipt', partyId: '', paymentDate: ctx.today, mode: 'cash', instrumentNo: '', instrumentDate: '',
      chequeBank: '', amount: '', discount: '', accountId: '', note: '', allocations: [],
    },
  });
  const watched = useWatch({ control });
  const direction = watched.direction ?? 'receipt';
  const partyId = watched.partyId ?? '';
  const mode = watched.mode ?? 'cash';
  const amount = watched.amount ?? '';
  const party = partiesById.get(partyId);

  const invoiceType = direction === 'receipt' ? 'sales_invoice' : 'purchase_invoice';
  const openForParty = useMemo(
    () => ctx.openInvoices.filter((i) => i.partyId === partyId && i.invoiceType === invoiceType),
    [ctx.openInvoices, partyId, invoiceType],
  );

  useEffect(() => {
    if (failure || notice) alertRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [failure, notice]);

  // Switching direction (admin only) or party drops allocations that no longer apply to anything on screen.
  function setDirection(next: 'receipt' | 'payment') {
    setValue('direction', next, { shouldValidate: true });
    setValue('partyId', '', { shouldValidate: true });
    setAllocations({});
  }
  function pickParty(id: string) {
    setValue('partyId', id, { shouldValidate: true });
    setAllocations({});
  }

  const partyOptions: PickerOption[] = useMemo(
    () =>
      ctx.parties
        .filter((p) => (direction === 'receipt' ? p.type !== 'supplier' : p.type !== 'customer'))
        .map((p) => ({ id: p.id, title: p.name, disabled: false, sub: p.isActive ? undefined : ts('disabledTag'), search: p.name.toLowerCase() })),
    [ctx.parties, direction, ts],
  );

  const accountLabel = (a: FormAccount) => (a.systemKey === 'cash' ? ts('accountCash') : a.systemKey === 'bank' ? ts('accountBank') : a.name);

  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);

  const allocated = useMemo(() => Object.values(allocations).reduce((s, v) => (v ? addDecimal(s, v, 2) ?? s : s), '0.00'), [allocations]);
  const onAccountAmount = useMemo(() => {
    const r = addDecimal(amount || '0.00', `-${allocated}`, 2) ?? '0.00';
    return r.startsWith('-') ? '0.00' : r;
  }, [amount, allocated]);
  const balanceAfter = useMemo(() => {
    if (!party) return null;
    const bal = direction === 'receipt' ? party.arBalance : party.apBalance;
    const delta = direction === 'receipt' ? `-${amount || '0.00'}` : amount || '0.00';
    return addDecimal(bal, delta, 2);
  }, [party, direction, amount]);

  const zeroAmount = !amount || compareDecimal(amount, '0.00', 2) !== 1;

  async function askToPost() {
    setFailure(null);
    setNotice(null);
    if (!(await trigger())) return;
    if (getValues('paymentDate') > ctx.today) return setFailure({ message: te('validation.payment_date_future') });
    if (zeroAmount) return setFailure({ message: te('field.money_invalid') });
    setConfirm('post');
  }

  const execute = (kind: 'save' | 'post') =>
    handleSubmit((values) =>
      start(async () => {
        setFailure(null);
        setNotice(null);
        if (values.paymentDate > ctx.today) return setFailure({ message: te('validation.payment_date_future') });
        const payload = {
          ...values,
          id: draftId ?? undefined,
          expectedUpdatedAt: updatedAt ?? undefined,
          allocations: Object.entries(allocations).filter(([, v]) => v).map(([invoiceId, v]) => ({ invoiceType, invoiceId, amount: v })),
        };
        const saved = await saveDraftPayment(payload);
        if (!saved.ok) {
          setConfirm(null);
          return setFailure({ message: saved.error, code: saved.code });
        }
        setDraftId(saved.data.id);
        setUpdatedAt(saved.data.updatedAt);
        if (!draftId) window.history.replaceState(null, '', `/payments/new?id=${saved.data.id}`);
        if (kind === 'save') {
          setConfirm(null);
          return setNotice(ts('savedNotice'));
        }

        const res = await postPayment({ id: saved.data.id });
        if (!res.ok) {
          setConfirm(null);
          return setFailure({ message: res.error, code: res.code });
        }
        setConfirm(null);
        setNotice(t('postedNotice', { number: res.data.voucherNo }));
        setDraftId(null);
        setUpdatedAt(null);
        setAllocations({});
        reset({
          direction: 'receipt', partyId: '', paymentDate: ctx.today, mode: 'cash', instrumentNo: '', instrumentDate: '',
          chequeBank: '', amount: '', discount: '', accountId: '', note: '', allocations: [],
        });
        window.history.replaceState(null, '', '/payments/new');
        router.refresh();
      }),
    )();

  return (
    <div className="screen stack">
      <div className="screenhead" style={{ marginBottom: 0 }}>
        <Link href="/payments" className="btn ghost sm">{t('back')}</Link>
        <h1>{direction === 'receipt' ? t('titleReceive') : t('titlePay')}</h1>
        <Chip tone="muted">{ts('statusDraft')}</Chip>
      </div>

      <form onSubmit={(e) => e.preventDefault()} noValidate className="bill">
        <div className="billmain stack">
          <div ref={alertRef} aria-live="polite">
            {failure && (
              <div role="alert" className="alert bad">
                {failure.message}
                {failure.code === 'conflict' && (
                  <>
                    {' '}
                    <button type="button" className="linkbtn" onClick={() => window.location.reload()}>{t('reload')}</button>
                  </>
                )}
              </div>
            )}
            {notice && <div role="status" className="alert good">{notice}</div>}
          </div>

          <Card>
            {ctx.isAdmin && (
              <div className="sitechips" role="group" aria-label={t('directionReceive')} style={{ marginBottom: 12 }}>
                <button type="button" className={`chipbtn${direction === 'receipt' ? ' on' : ''}`} aria-pressed={direction === 'receipt'} onClick={() => setDirection('receipt')}>
                  {t('directionReceive')}
                </button>
                <button type="button" className={`chipbtn${direction === 'payment' ? ' on' : ''}`} aria-pressed={direction === 'payment'} onClick={() => setDirection('payment')}>
                  {t('directionPay')}
                </button>
              </div>
            )}

            <div className="fieldrow">
              <Field id="pay-party" label={direction === 'receipt' ? t('fromCustomer') : t('toSupplier')} error={err(errors.partyId?.message)} className="grow2">
                <Picker
                  id="pay-party" options={partyOptions} value={partyId} onPick={pickParty}
                  placeholder={direction === 'receipt' ? ts('pickCustomer') : t('pickSupplier')}
                  dialogTitle={direction === 'receipt' ? ts('pickCustomer') : t('pickSupplier')}
                  searchLabel={direction === 'receipt' ? ts('searchCustomers') : t('searchSuppliers')}
                  emptyText={ts('noMatches')} closeLabel={tc('close')}
                />
              </Field>
              <Field id="pay-date" label={t('dateLabel')} hint={ts('dateHint')} error={err(errors.paymentDate?.message)} className="datefield">
                <DateField
                  id="pay-date" value={watched.paymentDate ?? ''} placeholder="DD-MM-YYYY"
                  onChange={(iso) => setValue('paymentDate', iso, { shouldValidate: true, shouldDirty: true })}
                />
              </Field>
            </div>

            <div className="fieldrow">
              <Field id="pay-amount" label={t('amountLabel')} error={err(errors.amount?.message)}>
                <input id="pay-amount" className="num" inputMode="decimal" autoComplete="off" {...register('amount')} />
              </Field>
              <Field id="pay-mode" label={t('modeLabel')} error={err(errors.mode?.message)}>
                <select id="pay-mode" {...register('mode')}>
                  {PAYMENT_MODES.map((m) => <option key={m} value={m}>{ts(`mode${m[0]!.toUpperCase()}${m.slice(1)}`)}</option>)}
                </select>
              </Field>
              <Field id="pay-account" label={direction === 'receipt' ? t('intoAccount') : t('fromAccount')} error={err(errors.accountId?.message)}>
                <select id="pay-account" {...register('accountId')}>
                  <option value="">—</option>
                  {ctx.accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
                </select>
              </Field>
              <Field id="pay-ref" label={mode === 'cheque' ? t('chequeNoLabel') : t('refLabel')} error={err(errors.instrumentNo?.message)}>
                <input id="pay-ref" className="mono" autoComplete="off" {...register('instrumentNo')} />
              </Field>
            </div>

            {mode === 'cheque' && (
              <div className="fieldrow" style={{ padding: 10, borderRadius: 'var(--r-inner)', background: 'var(--surface2)' }}>
                <Field id="pay-chq-date" label={t('chequeDateLabel')} error={err(errors.instrumentDate?.message)}>
                  <DateField
                    id="pay-chq-date" value={watched.instrumentDate ?? ''} placeholder="DD-MM-YYYY"
                    onChange={(iso) => setValue('instrumentDate', iso, { shouldValidate: true, shouldDirty: true })}
                  />
                </Field>
                <Field id="pay-chq-bank" label={t('chequeBankLabel')} error={err(errors.chequeBank?.message)}>
                  <input id="pay-chq-bank" autoComplete="off" {...register('chequeBank')} />
                </Field>
                <p className="hint" style={{ flexBasis: '100%' }}>{t('chequeNote')}</p>
              </div>
            )}

            {ctx.isAdmin && (
              <div className="fieldrow">
                <Field id="pay-discount" label={t('discountLabel')} error={err(errors.discount?.message)}>
                  <input id="pay-discount" className="num" inputMode="decimal" autoComplete="off" {...register('discount')} />
                </Field>
                <Field id="pay-note" label={t('noteLabel')} error={err(errors.note?.message)}>
                  <input id="pay-note" autoComplete="off" {...register('note')} />
                </Field>
              </div>
            )}
            {!ctx.isAdmin && (
              <div className="fieldrow">
                <Field id="pay-note" label={t('noteLabel')} error={err(errors.note?.message)}>
                  <input id="pay-note" autoComplete="off" {...register('note')} />
                </Field>
              </div>
            )}
          </Card>

          <Card>
            {party ? (
              <AllocationGrid
                invoices={openForParty} values={allocations} amount={amount}
                onChange={(id, v) => setAllocations((prev) => ({ ...prev, [id]: v }))}
                onAutoAllocate={() => setAllocations(autoAllocateOldestFirst(openForParty, amount))}
                onClear={() => setAllocations({})}
              />
            ) : (
              <p className="hint" style={{ margin: 0 }}>{t('pickPartyHint')}</p>
            )}
          </Card>
        </div>

        <aside className="floatpanel" aria-label={t('outstanding')}>
          <GlassPanel strong className="card panelcard">
            {party && (
              <div className="partycard">
                <div className="n">{party.name}</div>
                <div className="g">
                  {t('outstanding')} <b className="num">{inr(direction === 'receipt' ? party.arBalance : party.apBalance)}</b>
                </div>
              </div>
            )}
            <div className="totals">
              <div className="row"><span>{direction === 'receipt' ? t('receivedRow') : t('paidRow')}</span><b className="num">{inr2(amount || '0.00')}</b></div>
              <div className="row"><span>{t('allocatedRow')}</span><span className="num">{inr2(allocated)}</span></div>
              <div className="row"><span>{t('onAccountRow')}</span><span className="num">{inr2(onAccountAmount)}</span></div>
              {balanceAfter !== null && (
                <div className="row grand"><span>{t('outstanding')}</span><span className="num">{inr2(balanceAfter)}</span></div>
              )}
            </div>
          </GlassPanel>

          <GlassPanel className="actionbar">
            <div className="actiontotal">
              <div>
                <span className="lbl">{t('amountLabel')}</span>
                <b className="num">{inr2(amount || '0.00')}</b>
              </div>
              <button type="button" className="btn ghost big" disabled={pending} onClick={() => execute('save')}>
                {pending && !confirm ? tc('saving') : ts('saveDraft')}
              </button>
            </div>
            <div className="actionbtns">
              <button type="button" className="btn primary big" disabled={pending} onClick={askToPost}>
                {direction === 'receipt' ? t('postReceipt') : t('postPayment')}
              </button>
            </div>
          </GlassPanel>
        </aside>
      </form>

      <Modal open={confirm === 'post'} onClose={() => setConfirm((c) => (c === 'post' ? null : c))} title={t('confirmPostTitle')} closeLabel={tc('close')}>
        <p>{t('confirmPostBody', { party: party?.name ?? '', amount: inr2(amount || '0.00') })}</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>{tc('cancel')}</button>
          <button type="button" className="btn primary" disabled={pending} onClick={() => execute('post')}>
            {pending ? ts('posting') : t('confirmPost')}
          </button>
        </div>
      </Modal>
    </div>
  );
}
