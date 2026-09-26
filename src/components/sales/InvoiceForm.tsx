'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useFieldArray, useForm, useWatch, type Resolver } from 'react-hook-form';
import { deleteDraftInvoice, postCashSale, postInvoice, saveDraftInvoice } from '@/app/actions/sales';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { DateField } from '@/components/ui/DateField';
import { Field } from '@/components/ui/Field';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { Modal } from '@/components/ui/Modal';
import { Picker, type PickerOption } from '@/components/ui/Picker';
import type { ErrorCode } from '@/lib/action-result';
import { addDecimal, compareDecimal } from '@/lib/decimal';
import { formatDate, inr, inr2, inrRate } from '@/lib/format';
import { EWAY_BILL_THRESHOLD, GST_STATES, stateName } from '@/lib/gst';
import { previewTotals } from '@/lib/invoice-math';
import type { FormAccount, FormParty, InvoiceFormContext, InvoiceFormInitial, InvoiceFormValues } from '@/lib/sales-types';
import { altToBase, baseToAlt, rateText, trimZeros } from '@/lib/units';
import { saveDraftSchema, TRANSPORT_MODES } from '@/schemas/sales';
import { LineRow } from './LineRow';
import { TotalsRows } from './TotalsPanel';

type Confirm = null | 'post' | 'cash' | 'override' | 'delete';

const emptyLine = () => ({ itemId: '', qty: '', altQty: '', rate: '', discountPct: '' });

interface Props {
  ctx: InvoiceFormContext;
  /** Present when editing an existing draft. */
  initial?: InvoiceFormInitial;
  /** An owner who has passed the authenticator step: the only one who sees the credit-limit override. */
  isAdmin: boolean;
}

export function InvoiceForm({ ctx, initial, isAdmin }: Props) {
  const t = useTranslations('sales');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draftId, setDraftId] = useState<string | null>(initial?.id ?? null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(initial?.updatedAt ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; code?: ErrorCode } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const cashAccount = ctx.accounts.find((a) => a.systemKey === 'cash') ?? ctx.accounts[0];
  const [accountId, setAccountId] = useState(cashAccount?.id ?? '');
  const alertRef = useRef<HTMLDivElement>(null);
  // A draft started from a delivery challan: the database compares customer, stock items and quantities (and that the
  // invoice is not dated before the challan) when posting, so exactly those are fixed here.
  const challan = initial?.challan;

  const partiesById = useMemo(() => new Map(ctx.parties.map((p) => [p.id, p])), [ctx.parties]);
  const itemsById = useMemo(() => new Map(ctx.items.map((i) => [i.id, i])), [ctx.items]);

  const { register, handleSubmit, control, setValue, getValues, trigger, formState: { errors } } = useForm<InvoiceFormValues>({
    // The shared schema is the one source of truth; its input type is looser than the form's, hence the cast.
    resolver: zodResolver(saveDraftSchema) as unknown as Resolver<InvoiceFormValues>,
    defaultValues: initial?.values ?? {
      partyId: '', invoiceDate: ctx.today, placeOfSupply: ctx.orgState, siteId: '', vehicleNo: '', transporterName: '', transportMode: '', distanceKm: '', transporterGstin: '', lines: [emptyLine()],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const watched = useWatch({ control });
  const partyId = watched.partyId ?? '';
  const siteId = watched.siteId ?? '';
  const lines = useMemo(() => watched.lines ?? [], [watched.lines]);
  const party: FormParty | undefined = partiesById.get(partyId);
  // Place of supply is not typed in: it is the delivery site's state, else the customer's own.
  const site = party?.sites.find((s) => s.id === siteId && !s.isBilling);
  const place = site?.stateCode ?? party?.stateCode ?? ctx.orgState;
  const intra = place === ctx.orgState;

  const totals = useMemo(
    () =>
      previewTotals(
        lines.map((l) => ({ qty: l?.qty ?? '', rate: l?.rate ?? '', discountPct: l?.discountPct ?? '', gstRate: itemsById.get(l?.itemId ?? '')?.gstRate ?? '' })),
        intra,
      ),
    [lines, itemsById, intra],
  );

  useEffect(() => {
    setValue('placeOfSupply', place);
  }, [place, setValue]);

  useEffect(() => {
    if (failure || notice) alertRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [failure, notice]);

  const partyOptions: PickerOption[] = useMemo(
    () =>
      [...ctx.parties]
        .sort((a, b) => Number(b.isWalkIn) - Number(a.isWalkIn) || a.name.localeCompare(b.name))
        .map((p) => ({
          id: p.id, title: p.name, disabled: false,
          sub: [p.isWalkIn ? t('walkInTag') : null, p.gstin, stateName(p.stateCode), p.isActive ? null : t('disabledTag')].filter(Boolean).join(' · '),
          search: `${p.name} ${p.gstin ?? ''} ${stateName(p.stateCode)}`.toLowerCase(),
        })),
    [ctx.parties, t],
  );
  const itemOptions: PickerOption[] = useMemo(
    () =>
      ctx.items.map((i) => ({
        id: i.id, title: i.brand ? `${i.name} · ${i.brand}` : i.name,
        sub: [`HSN ${i.hsn}`, `${inrRate(i.saleRate)}/${i.baseUom}`, i.isStock ? t('onHand', { qty: trimZeros(i.onHand), uom: i.baseUom }) : null, i.isActive ? null : t('disabledTag')]
          .filter(Boolean).join(' · '),
        search: `${i.name} ${i.brand ?? ''} ${i.hsn}`.toLowerCase(),
      })),
    [ctx.items, t],
  );

  // Beside a challan, a line for a stock item is the challan's own; only non-stock charges (freight, hamali) may be added.
  const extraItemOptions: PickerOption[] = useMemo(
    () => (challan ? itemOptions.filter((o) => itemsById.get(o.id)?.isStock === false) : itemOptions),
    [challan, itemOptions, itemsById],
  );

  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);

  function pickParty(id: string) {
    const p = partiesById.get(id);
    if (!p) return;
    setValue('partyId', id, { shouldValidate: true });
    const site = p.sites.find((s) => s.id === p.defaultSiteId && !s.isBilling);
    setValue('siteId', site ? site.id : '');
  }

  function pickItem(index: number, id: string) {
    const item = itemsById.get(id);
    if (!item) return;
    setValue(`lines.${index}.itemId`, id, { shouldValidate: true });
    setValue(`lines.${index}.rate`, rateText(item.saleRate), { shouldValidate: true });
    const qty = getValues(`lines.${index}.qty`);
    setValue(`lines.${index}.altQty`, item.altUom && item.factor && qty ? trimZeros(baseToAlt(item.factor, qty) ?? '') : '');
  }

  // Typing one unit fills the other from the item's per-piece weight; the base unit is what is saved.
  function onQty(index: number, value: string) {
    const item = itemsById.get(getValues(`lines.${index}.itemId`));
    if (item?.altUom && item.factor) setValue(`lines.${index}.altQty`, trimZeros(baseToAlt(item.factor, value) ?? ''));
  }
  function onAlt(index: number, value: string) {
    const item = itemsById.get(getValues(`lines.${index}.itemId`));
    if (item?.altUom && item.factor) setValue(`lines.${index}.qty`, trimZeros(altToBase(item.factor, value) ?? ''), { shouldValidate: value !== '' });
  }

  // A hint only (the portal is the authority): goods above the threshold usually need an e-way bill.
  const needsEwb = compareDecimal(totals.grandTotal, EWAY_BILL_THRESHOLD, 2) === 1;

  const zeroTotal = totals.grandTotal === '0.00' || totals.lines.every((l) => l === null);

  /** Checks the form, then asks the person to confirm before anything is posted. */
  async function askToPost(kind: 'post' | 'cash') {
    setFailure(null);
    setNotice(null);
    if (!(await trigger())) return;
    if (getValues('invoiceDate') > ctx.today) return setFailure({ message: te('validation.date_future') });
    if (challan?.date && getValues('invoiceDate') < challan.date) return setFailure({ message: te('validation.invoice_before_challan') });
    if (zeroTotal) return setFailure({ message: te('validation.zero_total') });
    setConfirm(kind);
  }

  /** Saves the draft, and for `post` / `cash` also posts it. The database does the numbering and the sums. */
  const execute = (kind: 'save' | 'post' | 'cash', override = false) =>
    handleSubmit((values) =>
      start(async () => {
        setFailure(null);
        setNotice(null);
        if (values.invoiceDate > ctx.today) return setFailure({ message: te('validation.date_future') });
        const saved = await saveDraftInvoice({ ...values, id: draftId ?? undefined, expectedUpdatedAt: updatedAt ?? undefined });
        if (!saved.ok) {
          setConfirm(null);
          return setFailure({ message: saved.error, code: saved.code });
        }
        setDraftId(saved.data.id);
        setUpdatedAt(saved.data.updatedAt);
        if (!draftId) window.history.replaceState(null, '', `/sales/${saved.data.id}`);
        if (kind === 'save') {
          setConfirm(null);
          return setNotice(t('savedNotice'));
        }

        const res = kind === 'cash'
          ? await postCashSale({ id: saved.data.id, accountId })
          : await postInvoice({ id: saved.data.id, overrideCredit: override || undefined });
        if (!res.ok) {
          // Only an owner is offered the override; a counter user just sees the refusal.
          setConfirm(res.code === 'credit_limit' && isAdmin && kind === 'post' ? 'override' : null);
          return setFailure({ message: res.error, code: res.code });
        }
        router.push(`/sales/${res.data.id}/view?done=${kind === 'cash' ? 'cash' : 'posted'}`);
      }),
    )();

  const removeDraft = () =>
    start(async () => {
      if (!draftId) return router.push('/sales');
      const res = await deleteDraftInvoice({ id: draftId });
      if (!res.ok) {
        setConfirm(null);
        return setFailure({ message: res.error, code: res.code });
      }
      router.push('/sales');
    });

  const accountLabel = (a: FormAccount) => (a.systemKey === 'cash' ? t('accountCash') : a.systemKey === 'bank' ? t('accountBank') : a.name);
  const walkIn = !!party?.isWalkIn;
  const partyErr = err(errors.partyId?.message);
  const linesErr = err(errors.lines?.root?.message ?? errors.lines?.message);
  const overLimit =
    party && party.creditLimit !== null && !walkIn
      ? (() => {
          const after = addDecimal(party.balance, totals.grandTotal, 2);
          return after !== null && !after.startsWith('-') && compareDecimal(after, party.creditLimit, 2) === 1;
        })()
      : false;

  const paymentModalActions = (kind: 'post' | 'cash') => (
    <div className="modal-actions">
      <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>{tc('cancel')}</button>
      <button type="button" className="btn primary" disabled={pending || (kind === 'cash' && !accountId)} onClick={() => execute(kind)}>
        {pending ? t('posting') : kind === 'cash' ? t('confirmCash') : t('confirmPost')}
      </button>
    </div>
  );

  return (
    <div className="screen stack">
      <div className="screenhead" style={{ marginBottom: 0 }}>
        <Link href="/sales" className="btn ghost sm">{t('back')}</Link>
        <h1>{draftId ? t('titleEdit') : t('titleNew')}</h1>
        <Chip tone="muted">{t('statusDraft')}</Chip>
        <span className="sub mono">{t('numberOnPost')}</span>
        {draftId && (
          <span className="headbtns">
            <button type="button" className="btn danger sm" onClick={() => setConfirm('delete')}>{t('deleteDraft')}</button>
          </span>
        )}
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

          {challan && (
            <div role="note" className="alert warn">
              <b>{t('fromChallan', { no: challan.no, date: challan.date ? formatDate(challan.date) : '—' })}</b>
              <br />
              {t('challanLockedNote')}
            </div>
          )}

          <Card>
            <div className="fieldrow">
              <Field id="inv-party" label={t('customer')} error={partyErr} className="grow2">
                <Picker
                  id="inv-party" options={partyOptions} value={partyId} onPick={pickParty} placeholder={t('pickCustomer')}
                  dialogTitle={t('pickCustomer')} searchLabel={t('searchCustomers')} emptyText={t('noMatches')} closeLabel={tc('close')}
                  disabled={!!challan}
                />
              </Field>
              <Field id="inv-date" label={t('invoiceDate')} hint={t('dateHint')} error={err(errors.invoiceDate?.message)} className="datefield">
                <DateField
                  id="inv-date" value={watched.invoiceDate ?? ''} placeholder="DD-MM-YYYY"
                  onChange={(iso) => setValue('invoiceDate', iso, { shouldValidate: true, shouldDirty: true })}
                />
              </Field>
              <Field id="inv-pos" label={t('placeOfSupply')} error={err(errors.placeOfSupply?.message)} className="posfield">
                <select id="inv-pos" value={place} disabled>
                  {GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
                </select>
              </Field>
            </div>

            {party && (
              <div className="sitechips" role="group" aria-labelledby="inv-sites-label">
                <span className="lbl" id="inv-sites-label">{t('deliverTo')}</span>
                <SiteChip active={siteId === ''} onPick={() => setValue('siteId', '')} label={t('billingAddress')} />
                {party.sites.filter((s) => !s.isBilling).map((s) => (
                  <SiteChip key={s.id} active={siteId === s.id} onPick={() => setValue('siteId', s.id)} label={s.label} />
                ))}
                {party.sites.length === 0 && <span className="hint" style={{ margin: 0 }}>{t('noSites')}</span>}
              </div>
            )}

            <details className="transport">
              <summary>{t('transport')}</summary>
              <div className="fieldrow" style={{ marginTop: 10 }}>
                <Field id="inv-veh" label={t('vehicleNo')} error={err(errors.vehicleNo?.message)}>
                  <input id="inv-veh" className="mono" autoComplete="off" style={{ textTransform: 'uppercase' }} {...register('vehicleNo')} />
                </Field>
                <Field id="inv-trn" label={t('transporter')} error={err(errors.transporterName?.message)}>
                  <input id="inv-trn" autoComplete="off" {...register('transporterName')} />
                </Field>
              </div>
              <div className="fieldrow">
                <Field id="inv-mode" label={t('transportMode')} error={err(errors.transportMode?.message)}>
                  <select id="inv-mode" {...register('transportMode')}>
                    <option value="">—</option>
                    {TRANSPORT_MODES.map((m) => <option key={m} value={m}>{t(`mode_${m}`)}</option>)}
                  </select>
                </Field>
                <Field id="inv-dist" label={t('distanceKm')} error={err(errors.distanceKm?.message)}>
                  <input id="inv-dist" className="num" inputMode="numeric" autoComplete="off" {...register('distanceKm')} />
                </Field>
                <Field id="inv-tgst" label={t('transporterGstin')} error={err(errors.transporterGstin?.message)}>
                  <input id="inv-tgst" className="mono" autoComplete="off" style={{ textTransform: 'uppercase' }} {...register('transporterGstin')} />
                </Field>
              </div>
              <p className="hint">{t('ewbAfterPosting')}</p>
            </details>
          </Card>

          <Card>
            <div className="cardtitle"><span>{t('items')}</span></div>
            {linesErr && <p className="fielderror" role="alert">{linesErr}</p>}
            <div className="lines">
              {fields.map((f, i) => {
                const l = lines[i];
                const isLocked = !!challan && itemsById.get(l?.itemId ?? '')?.isStock === true;
                return (
                  <LineRow
                    key={f.id} index={i} item={itemsById.get(l?.itemId ?? '')} itemOptions={isLocked ? itemOptions : extraItemOptions} locked={isLocked} itemId={l?.itemId ?? ''}
                    qty={l?.qty ?? ''} preview={totals.lines[i] ?? null} register={register} errors={errors}
                    onPickItem={(id) => pickItem(i, id)} onQty={(v) => onQty(i, v)} onAlt={(v) => onAlt(i, v)}
                    onRemove={() => (fields.length > 1 ? remove(i) : setValue(`lines.${i}`, emptyLine()))}
                  />
                );
              })}
            </div>
            <button type="button" className="btn ghost addline" onClick={() => append(emptyLine())}>+ {t('addItem')}</button>
            <p className="hint">{t('altHint')}</p>
          </Card>
        </div>

        <aside className="floatpanel" aria-label={t('summary')}>
          <GlassPanel strong className="card panelcard">
            {party ? (
              <div className="partycard">
                <div className="n">{party.name}</div>
                <div className="g mono">
                  {[party.gstin ? `GSTIN ${party.gstin}` : t('noGstin'), `${stateName(party.stateCode)} (${party.stateCode})`].join(' · ')}
                </div>
                <div className="g">{intra ? t('intraNote') : t('interNote')}</div>
                {!walkIn && (
                  <>
                    <div className="g" style={{ marginTop: 6 }}>
                      {t('balance')}: <b className="num">{inr(party.balance)}</b>
                    </div>
                    <div className="g">
                      {party.creditLimit === null ? t('limitNone') : Number(party.creditLimit) === 0 ? t('limitZero') : t('limitIs', { amount: inr(party.creditLimit) })}
                    </div>
                    {overLimit && <div className="g warntext" role="status">{t('overLimit')}</div>}
                  </>
                )}
                {walkIn && <div className="g">{t('walkInHint')}</div>}
              </div>
            ) : (
              <p className="hint" style={{ margin: '0 0 10px' }}>{t('pickCustomerHint')}</p>
            )}
            <div className="previewtag">{t('preview')}</div>
            <TotalsRows
              totals={totals} intra={intra}
              labels={{ taxable: t('taxableValue'), cgst: 'CGST', sgst: 'SGST', igst: 'IGST', roundOff: t('roundOff'), total: t('total') }}
            />
            {needsEwb && <p className="postnote warntext" role="note">{t('ewbHint', { amount: inr(EWAY_BILL_THRESHOLD) })}</p>}
            <p className="postnote">{t('previewNote')}</p>
            <p className="postnote">{ctx.hasUpi ? t('upiNoteOn') : isAdmin ? t('upiNoteOffOwner') : t('upiNoteOff')}</p>
          </GlassPanel>

          <GlassPanel className="actionbar">
            <div className="actiontotal">
              <div>
                <span className="lbl">{t('total')}</span>
                <b className="num">{inr2(totals.grandTotal)}</b>
              </div>
              <button type="button" className="btn ghost big" disabled={pending} onClick={() => execute('save')}>
                {pending && !confirm ? tc('saving') : t('saveDraft')}
              </button>
            </div>
            <div className="actionbtns">
              <button type="button" className={`btn ${walkIn ? 'ghost' : 'primary'} big`} disabled={pending} onClick={() => askToPost('post')}>
                {t('post')}
              </button>
              <button type="button" className={`btn ${walkIn ? 'primary' : 'ghost'} big`} disabled={pending} onClick={() => askToPost('cash')}>
                {t('postCash')}
              </button>
            </div>
          </GlassPanel>
        </aside>
      </form>

      <Modal open={confirm === 'post'} onClose={() => setConfirm((c) => (c === 'post' ? null : c))} title={t('confirmPostTitle')} closeLabel={tc('close')}>
        <p>{t('confirmPostBody', { party: party?.name ?? '', amount: inr2(totals.grandTotal) })}</p>
        {paymentModalActions('post')}
      </Modal>

      <Modal open={confirm === 'cash'} onClose={() => setConfirm((c) => (c === 'cash' ? null : c))} title={t('confirmCashTitle')} closeLabel={tc('close')}>
        <p>{t('confirmCashBody', { party: party?.name ?? '', amount: inr2(totals.grandTotal) })}</p>
        <fieldset className="radios">
          <legend className="lbl">{t('receivedInto')}</legend>
          {ctx.accounts.map((a) => (
            <label key={a.id} className="radio">
              <input type="radio" name="cash-account" value={a.id} checked={accountId === a.id} onChange={() => setAccountId(a.id)} />
              <span>{accountLabel(a)}</span>
            </label>
          ))}
        </fieldset>
        {paymentModalActions('cash')}
      </Modal>

      <Modal open={confirm === 'override'} onClose={() => setConfirm((c) => (c === 'override' ? null : c))} title={t('overrideTitle')} closeLabel={tc('close')}>
        <p>{failure?.message}</p>
        <p>{t('overrideBody', { party: party?.name ?? '' })}</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>{tc('cancel')}</button>
          <button type="button" className="btn danger" disabled={pending} onClick={() => execute('post', true)}>
            {pending ? t('posting') : t('overrideConfirm')}
          </button>
        </div>
      </Modal>

      <Modal open={confirm === 'delete'} onClose={() => setConfirm((c) => (c === 'delete' ? null : c))} title={t('deleteTitle')} closeLabel={tc('close')}>
        <p>{t('deleteBody')}</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>{tc('cancel')}</button>
          <button type="button" className="btn danger" disabled={pending} onClick={removeDraft}>{t('deleteConfirm')}</button>
        </div>
      </Modal>
    </div>
  );
}

function SiteChip({ active, onPick, label }: { active: boolean; onPick: () => void; label: string }) {
  return (
    <button type="button" className={`chipbtn${active ? ' on' : ''}`} aria-pressed={active} onClick={onPick}>
      {label}
    </button>
  );
}
