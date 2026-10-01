'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useFieldArray, useForm, useWatch, type Resolver } from 'react-hook-form';
import { deleteDraftNote, postNote, saveDraftNote } from '@/app/actions/notes';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { DateField } from '@/components/ui/DateField';
import { Field } from '@/components/ui/Field';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { KeyValue } from '@/components/ui/KeyValue';
import { Modal } from '@/components/ui/Modal';
import type { ErrorCode } from '@/lib/action-result';
import { compareDecimal, signOf } from '@/lib/decimal';
import { formatDate, inr2 } from '@/lib/format';
import { NOTE_CONFIG, type NoteFormContext, type NoteFormInitial, type NoteFormValues, type NoteSourceLine } from '@/lib/notes-types';
import { baseToAlt, qtyDisplay, trimZeros } from '@/lib/units';
import { saveDraftNoteSchema } from '@/schemas/notes';

type Confirm = null | 'post' | 'delete';

interface Props {
  ctx: NoteFormContext;
  /** Present when editing an existing draft. */
  initial?: NoteFormInitial;
}

/**
 * One form for both notes. The note always starts from a posted invoice (credit note) or bill (debit
 * note): the person picks which of its lines the note covers and how much. Nothing here works out tax
 * or totals; the database does that when the note is posted, and the posted view shows what it stored.
 */
export function NoteForm({ ctx, initial }: Props) {
  const { kind, invoice } = ctx;
  const cfg = NOTE_CONFIG[kind];
  const t = useTranslations('notes');
  const tk = useTranslations(`notes.${kind}`);
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draftId, setDraftId] = useState<string | null>(initial?.id ?? null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(initial?.updatedAt ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; code?: ErrorCode } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const sourceById = useMemo(() => new Map(invoice.lines.map((l) => [l.id, l])), [invoice.lines]);

  // The shared schema is the one source of truth. `kind` and `invoiceId` are fixed by the page, not typed
  // into the form, so they are added when the values are validated; its input type is looser than the form's, hence the casts.
  const base = zodResolver(saveDraftNoteSchema) as unknown as Resolver<Record<string, unknown>>;
  const resolver: Resolver<NoteFormValues> = (values, context, options) =>
    base({ ...values, kind, invoiceId: invoice.id }, context, options as never) as ReturnType<Resolver<NoteFormValues>>;

  const { register, handleSubmit, control, setValue, getValues, trigger, formState: { errors } } = useForm<NoteFormValues>({
    resolver,
    defaultValues: initial?.values ?? { noteDate: ctx.today, reason: '', stockEffect: true, lines: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const watched = useWatch({ control });
  const stockEffect = watched.stockEffect ?? true;
  const lines = useMemo(() => watched.lines ?? [], [watched.lines]);
  const usedIds = new Set(lines.map((l) => l?.againstLineId));
  // Lines with nothing left to return (or to adjust, for a value-only note) are not offered.
  const unused = invoice.lines.filter((l) => !usedIds.has(l.id) && signOf(stockEffect ? l.remainingQty : l.remainingTaxable) > 0);

  useEffect(() => {
    if (failure || notice) alertRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [failure, notice]);

  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);

  /** The soft checks the form can make before asking the database: more than what is left on that invoice line. */
  function overLimit(): string | null {
    const values = getValues();
    if (!values.stockEffect) return null;
    for (const l of values.lines) {
      const src = sourceById.get(l.againstLineId);
      if (src && compareDecimal(l.qty, src.remainingQty, 3) === 1) return te('validation.qty_exceeds_invoice');
    }
    return null;
  }

  /** Checks the form, then asks the person to confirm before anything is posted. */
  async function askToPost() {
    setFailure(null);
    setNotice(null);
    if (!(await trigger())) return;
    if (getValues('noteDate') > ctx.today) return setFailure({ message: te('validation.note_date_future') });
    const over = overLimit();
    if (over) return setFailure({ message: over });
    setConfirm('post');
  }

  /** Saves the draft, and for `post` also posts it. The database does the numbering, the tax and the sums. */
  const execute = (what: 'save' | 'post') =>
    handleSubmit((values) =>
      start(async () => {
        setFailure(null);
        setNotice(null);
        if (values.noteDate > ctx.today) return setFailure({ message: te('validation.note_date_future') });
        const saved = await saveDraftNote({ ...values, kind, invoiceId: invoice.id, id: draftId ?? undefined, expectedUpdatedAt: updatedAt ?? undefined });
        if (!saved.ok) {
          setConfirm(null);
          return setFailure({ message: saved.error, code: saved.code });
        }
        setDraftId(saved.data.id);
        setUpdatedAt(saved.data.updatedAt);
        if (!draftId) window.history.replaceState(null, '', `${cfg.base}/${saved.data.id}`);
        if (what === 'save') {
          setConfirm(null);
          return setNotice(t('savedNotice'));
        }

        const res = await postNote({ kind, id: saved.data.id });
        if (!res.ok) {
          setConfirm(null);
          return setFailure({ message: res.error, code: res.code });
        }
        router.push(`${cfg.base}/${res.data.id}/view?done=posted`);
      }),
    )();

  const removeDraft = () =>
    start(async () => {
      if (!draftId) return router.push(`${cfg.invoiceBase}/${invoice.id}/view`);
      const res = await deleteDraftNote({ kind, id: draftId });
      if (!res.ok) {
        setConfirm(null);
        return setFailure({ message: res.error, code: res.code });
      }
      router.push(`${cfg.invoiceBase}/${invoice.id}/view`);
    });

  const linesErr = err(errors.lines?.root?.message ?? errors.lines?.message);
  const addLine = (l: NoteSourceLine) => append({ againstLineId: l.id, qty: '', rate: '' });

  return (
    <div className="screen stack">
      <div className="screenhead" style={{ marginBottom: 0 }}>
        <Link href={`${cfg.invoiceBase}/${invoice.id}/view`} className="btn ghost sm">← {invoice.number}</Link>
        <h1>{draftId ? tk('titleEdit') : tk('titleNew')}</h1>
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

          <Card>
            <KeyValue
              rows={[
                { label: tk('against'), value: <><span className="mono">{invoice.number}</span> · <span className="num">{formatDate(invoice.date)}</span></> },
                { label: tk('party'), value: <>{invoice.partyName}{invoice.partyGstin ? <span className="mono sub"> · {invoice.partyGstin}</span> : null}</> },
                ...(invoice.supplierBillNo ? [{ label: t('supplierBillNo'), value: <span className="mono">{invoice.supplierBillNo}</span> }] : []),
              ]}
            />
            <div className="fieldrow" style={{ marginTop: 14 }}>
              <Field id="note-date" label={t('noteDate')} hint={t('dateHint')} error={err(errors.noteDate?.message)} className="datefield">
                <DateField
                  id="note-date" value={watched.noteDate ?? ''} placeholder="DD-MM-YYYY"
                  onChange={(iso) => setValue('noteDate', iso, { shouldValidate: true, shouldDirty: true })}
                />
              </Field>
              <Field id="note-reason" label={t('reason')} hint={t('reasonHint')} error={err(errors.reason?.message)} className="grow2">
                <input id="note-reason" autoComplete="off" maxLength={200} {...register('reason')} />
              </Field>
            </div>
            <label className="radio" style={{ marginTop: 6 }}>
              <input type="checkbox" {...register('stockEffect')} />
              <span>{tk('stockSwitch')}</span>
            </label>
            <p className="hint">{stockEffect ? tk('stockYes') : tk('stockNo')}</p>
          </Card>

          <Card>
            <div className="cardtitle"><span>{t('items')}</span></div>
            {linesErr && <p className="fielderror" role="alert">{linesErr}</p>}
            <div className="lines">
              {fields.map((f, i) => {
                const l = lines[i];
                const src = sourceById.get(l?.againstLineId ?? f.againstLineId);
                const e = errors.lines?.[i];
                if (!src) return null;
                const pcs = src.altUom && src.factor && l?.qty ? baseToAlt(src.factor, l.qty) : null;
                return (
                  <div className="lrow" role="group" aria-label={t('lineN', { n: i + 1 })} key={f.id}>
                    <div className="lhead">
                      <div className="litem">
                        <b>{src.itemName}</b>
                        <p className="sub lineinfo" style={{ margin: 0 }}>
                          <span className="mono">HSN {src.hsn}</span> · GST {trimZeros(src.gstRate)}% ·{' '}
                          {t('onInvoice', { qty: qtyDisplay(src.qty), uom: src.uom, amount: inr2(src.taxable) })}
                        </p>
                      </div>
                      <button type="button" className="iconbtn lremove" onClick={() => remove(i)} aria-label={t('removeLine', { n: i + 1 })}>
                        <span aria-hidden="true">✕</span>
                      </button>
                    </div>
                    <div className="lnums">
                      <Field
                        id={`l${i}-qty`} label={t('qtyIn', { uom: src.uom })} error={err(e?.qty?.message)}
                        hint={stockEffect ? t('returnable', { qty: qtyDisplay(src.remainingQty), uom: src.uom }) : undefined}
                      >
                        <input id={`l${i}-qty`} inputMode="decimal" autoComplete="off" className="num r" {...register(`lines.${i}.qty`)} />
                      </Field>
                      {!stockEffect && (
                        <Field
                          id={`l${i}-rate`} label={t('rateLabel')} error={err(e?.rate?.message)}
                          hint={t('adjustable', { amount: inr2(src.remainingTaxable) })}
                        >
                          <input id={`l${i}-rate`} inputMode="decimal" autoComplete="off" className="num r" {...register(`lines.${i}.rate`)} />
                        </Field>
                      )}
                      {pcs && src.altUom && (
                        <div className="lamt">
                          <span className="lbl">{src.altUom}</span>
                          <b className="num">≈ {trimZeros(pcs)}</b>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {unused.length > 0 ? (
              <div className="sitechips" style={{ marginTop: 14 }}>
                <span className="lbl">{t('addFromInvoice', { number: invoice.number })}</span>
                {unused.map((l) => (
                  <button type="button" key={l.id} className="chipbtn" onClick={() => addLine(l)}>+ {l.itemName}</button>
                ))}
              </div>
            ) : (
              <p className="hint">{t('allLinesAdded')}</p>
            )}
            <p className="hint">{t('altHint')}</p>
          </Card>
        </div>

        <aside className="floatpanel" aria-label={t('summary')}>
          <GlassPanel strong className="card panelcard">
            <div className="partycard">
              <div className="n">{invoice.partyName}</div>
              <div className="g mono">{invoice.number}</div>
            </div>
            <KeyValue
              rows={[
                { label: tk('invoiceTotal'), value: <b className="num">{inr2(invoice.grandTotal)}</b> },
                { label: tk('unpaid'), value: invoice.openAmount === null ? t('nothingOpen') : <b className="num">{inr2(invoice.openAmount)}</b> },
              ]}
            />
            <p className="postnote">{t('totalsOnPost')}</p>
            {invoice.openAmount !== null && <p className="postnote">{tk('unpaidRule')}</p>}
            {invoice.openAmount === null && <p className="postnote">{tk('paidRule')}</p>}
          </GlassPanel>

          <GlassPanel className="actionbar">
            <div className="actionbtns">
              <button type="button" className="btn ghost big" disabled={pending} onClick={() => execute('save')}>
                {pending && !confirm ? tc('saving') : t('saveDraft')}
              </button>
              <button type="button" className="btn primary big" disabled={pending} onClick={askToPost}>{tk('post')}</button>
            </div>
          </GlassPanel>
        </aside>
      </form>

      <Modal open={confirm === 'post'} onClose={() => setConfirm((c) => (c === 'post' ? null : c))} title={tk('confirmPostTitle')} closeLabel={tc('close')}>
        <p>{tk('confirmPostBody', { party: invoice.partyName, number: invoice.number })}</p>
        <p className="hint">{stockEffect ? tk('confirmStockYes') : tk('confirmStockNo')}</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>{tc('cancel')}</button>
          <button type="button" className="btn primary" disabled={pending} onClick={() => execute('post')}>
            {pending ? t('posting') : tk('confirmPost')}
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
