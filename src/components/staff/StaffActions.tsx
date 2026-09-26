'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { createEmployee, recordAdvance, recordSalary, recordWages, updateEmployee } from '@/app/actions/staff';
import { DateField } from '@/components/ui/DateField';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { compareDecimal, multiplyDays, signOf, subtractDecimal } from '@/lib/decimal';
import { inr2 } from '@/lib/format';
import {
  advanceSchema, createEmployeeSchema, salarySchema, wagesSchema,
  type AdvanceInput, type EmployeeInput, type SalaryInput, type WagesInput,
} from '@/schemas/staff';

export interface StaffPerson {
  id: string;
  name: string;
  monthlySalary: string | null;
  dailyWage: string | null;
  /** Advance outstanding (positive = the person owes it back). */
  advance: string;
}
export interface PayAccount { id: string; name: string; systemKey: string | null }

interface Props {
  people: StaffPerson[];
  accounts: PayAccount[];
  today: string;
  /** Pre-selects this person (on their own ledger page). */
  personId?: string;
}

type Which = null | 'advance' | 'salary' | 'wages' | 'employee';
type ErrMsg = { message?: string } | undefined;

/** The owner-only staff buttons and their four modals. Rendered only for a verified owner. */
export function StaffActions({ people, accounts, today, personId }: Props) {
  const t = useTranslations('staff');
  const [open, setOpen] = useState<Which>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const done = (msg: string) => {
    setOpen(null);
    setNotice(msg);
  };
  return (
    <>
      <button type="button" className="btn ghost" onClick={() => setOpen('wages')}>+ {t('wagesBtn')}</button>
      <button type="button" className="btn ghost" onClick={() => setOpen('salary')}>+ {t('salaryBtn')}</button>
      <button type="button" className="btn primary" onClick={() => setOpen('advance')}>+ {t('advanceBtn')}</button>
      <Modal open={open === 'advance'} onClose={() => setOpen(null)} title={t('advanceTitle')} closeLabel={t('close')}>
        <AdvanceForm people={people} accounts={accounts} today={today} personId={personId} onDone={() => done(t('advanceDone'))} onCancel={() => setOpen(null)} />
      </Modal>
      <Modal open={open === 'salary'} onClose={() => setOpen(null)} title={t('salaryTitle')} closeLabel={t('close')}>
        <SalaryForm people={people} accounts={accounts} today={today} personId={personId} onDone={() => done(t('salaryDone'))} onCancel={() => setOpen(null)} />
      </Modal>
      <Modal open={open === 'wages'} onClose={() => setOpen(null)} title={t('wagesTitle')} closeLabel={t('close')}>
        <WagesForm people={people} accounts={accounts} today={today} personId={personId} onDone={() => done(t('wagesDone'))} onCancel={() => setOpen(null)} />
      </Modal>
      {notice && <p role="status" className="alert good" style={{ flexBasis: '100%', margin: 0 }}>{notice}</p>}
    </>
  );
}

function useAccountLabel() {
  const ts = useTranslations('sales');
  return (a: PayAccount) => (a.systemKey === 'cash' ? ts('accountCash') : a.systemKey === 'bank' ? ts('accountBank') : a.name);
}
const defaultAccount = (accounts: PayAccount[]) => accounts.find((a) => a.systemKey === 'cash')?.id ?? accounts[0]?.id ?? '';

function Actions({ pending, onCancel, submitLabel }: { pending: boolean; onCancel: () => void; submitLabel: string }) {
  const t = useTranslations('staff');
  return (
    <div className="modal-actions">
      <button type="button" className="btn ghost" onClick={onCancel}>{t('cancel')}</button>
      <button type="submit" className="btn primary" disabled={pending}>{submitLabel}</button>
    </div>
  );
}

function useSubmit(action: (values: never) => Promise<{ ok: boolean; error?: string }>, onDone: () => void) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const run = (values: unknown) => {
    setFailure(null);
    start(async () => {
      const res = await action(values as never);
      if (!res.ok) return setFailure(res.error ?? null);
      router.refresh();
      onDone();
    });
  };
  return { pending, failure, run };
}

function PersonField({ id, people, reg, error, blankLabel }: {
  id: string; people: StaffPerson[]; /** The spread of react-hook-form's register('employeeId'). */ reg: object; error?: string; blankLabel?: string;
}) {
  const t = useTranslations('staff');
  return (
    <Field id={id} label={t('employee')} error={error}>
      <select id={id} {...reg}>
        {blankLabel ? <option value="">{blankLabel}</option> : <option value="" disabled>{t('choosePerson')}</option>}
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </Field>
  );
}

function AdvanceForm({ people, accounts, today, personId, onDone, onCancel }: Props & { onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('staff');
  const te = useTranslations('errors');
  const label = useAccountLabel();
  // One id per open of the modal (its content unmounts on close): a retry after a lost response is the same request, not a second one.
  const [requestId] = useState(() => crypto.randomUUID());
  const { register, handleSubmit, setValue, control, formState: { errors } } = useForm<AdvanceInput>({
    resolver: zodResolver(advanceSchema) as unknown as Resolver<AdvanceInput>,
    defaultValues: { id: requestId, voucherDate: today, employeeId: personId ?? '', payAccountId: defaultAccount(accounts), amount: '', note: '' },
  });
  const date = useWatch({ control, name: 'voucherDate' });
  const { pending, failure, run } = useSubmit(recordAdvance, onDone);
  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);
  return (
    <form onSubmit={handleSubmit(run)} noValidate>
      <PersonField id="adv-emp" people={people} reg={register('employeeId')} error={err((errors.employeeId as ErrMsg)?.message)} />
      <div className="fieldrow">
        <Field id="adv-amount" label={t('amount')} error={err((errors.amount as ErrMsg)?.message)}>
          <input id="adv-amount" inputMode="decimal" autoComplete="off" className="num" {...register('amount')} />
        </Field>
        <Field id="adv-date" label={t('date')} className="datefield" error={err((errors.voucherDate as ErrMsg)?.message)}>
          <DateField id="adv-date" value={date} onChange={(iso) => setValue('voucherDate', iso, { shouldValidate: true })} placeholder="DD-MM-YYYY" />
        </Field>
      </div>
      <Field id="adv-account" label={t('paidFrom')} error={err((errors.payAccountId as ErrMsg)?.message)}>
        <select id="adv-account" {...register('payAccountId')}>{accounts.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}</select>
      </Field>
      <Field id="adv-note" label={t('note')} error={err((errors.note as ErrMsg)?.message)}>
        <input id="adv-note" autoComplete="off" placeholder={t('advanceNotePlaceholder')} {...register('note')} />
      </Field>
      <p className="minfo">{t('advanceInfo')}</p>
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      <Actions pending={pending} onCancel={onCancel} submitLabel={t('post')} />
    </form>
  );
}

/** Last 12 months up to and including the current one, as YYYY-MM. */
function monthOptions(today: string): string[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return Array.from({ length: 12 }, (_, i) => {
    const idx = y * 12 + (m - 1) - i;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  });
}

function SalaryForm({ people, accounts, today, personId, onDone, onCancel }: Props & { onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('staff');
  const te = useTranslations('errors');
  const locale = useLocale();
  const label = useAccountLabel();
  const salaried = useMemo(() => people.filter((p) => p.monthlySalary), [people]);
  const first = salaried.find((p) => p.id === personId) ?? salaried[0];

  // One id per open of the modal (its content unmounts on close): a retry after a lost response is the same request, not a second one.
  const [requestId] = useState(() => crypto.randomUUID());
  const { register, handleSubmit, setValue, control, formState: { errors } } = useForm<SalaryInput>({
    resolver: zodResolver(salarySchema) as unknown as Resolver<SalaryInput>,
    defaultValues: {
      id: requestId, voucherDate: today, employeeId: first?.id ?? '', payAccountId: defaultAccount(accounts), month: today.slice(0, 7),
      amount: first?.monthlySalary ?? '', advanceRecovered: '',
    },
  });
  const date = useWatch({ control, name: 'voucherDate' });
  const employeeId = useWatch({ control, name: 'employeeId' });
  const amount = String(useWatch({ control, name: 'amount' }) ?? '');
  const recovered = String(useWatch({ control, name: 'advanceRecovered' }) ?? '');
  const person = salaried.find((p) => p.id === employeeId);
  const { pending, failure, run } = useSubmit(recordSalary, onDone);
  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);
  const months = monthOptions(today);
  const monthName = (ym: string) =>
    new Intl.DateTimeFormat(locale === 'te' ? 'te-IN' : 'en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`));

  // The person's own salary pre-fills the amount when someone else is picked (still editable).
  useEffect(() => {
    if (person?.monthlySalary) setValue('amount', person.monthlySalary);
  }, [person, setValue]);

  // Preview only, mirroring what post_expense_voucher will do: recover the smaller of the advance and the salary unless told less.
  const preview = useMemo(() => {
    if (!person || !/^\d+(\.\d{1,2})?$/.test(amount ?? '')) return null;
    const adv = signOf(person.advance) === 1 ? person.advance : '0.00';
    const max = compareDecimal(adv, amount, 2) === 1 ? amount : adv;
    const rec = recovered && /^\d+(\.\d{1,2})?$/.test(recovered) ? recovered : max;
    const net = subtractDecimal(amount, rec, 2);
    return net === null ? null : { advance: adv, recovered: rec, net };
  }, [person, amount, recovered]);

  return (
    <form onSubmit={handleSubmit(run)} noValidate>
      {salaried.length === 0 ? (
        <p className="alert warn">{t('noSalaried')}</p>
      ) : (
        <>
          <PersonField id="sal-emp" people={salaried} reg={register('employeeId')} error={err((errors.employeeId as ErrMsg)?.message)} />
          <div className="fieldrow">
            <Field id="sal-month" label={t('month')} error={err((errors.month as ErrMsg)?.message)}>
              <select id="sal-month" {...register('month')}>{months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}</select>
            </Field>
            <Field id="sal-amount" label={t('grossSalary')} error={err((errors.amount as ErrMsg)?.message)}>
              <input id="sal-amount" inputMode="decimal" autoComplete="off" className="num" {...register('amount')} />
            </Field>
          </div>
          <div className="fieldrow">
            <Field id="sal-date" label={t('date')} className="datefield" error={err((errors.voucherDate as ErrMsg)?.message)}>
              <DateField id="sal-date" value={date} onChange={(iso) => setValue('voucherDate', iso, { shouldValidate: true })} placeholder="DD-MM-YYYY" />
            </Field>
            <Field id="sal-account" label={t('paidFrom')} error={err((errors.payAccountId as ErrMsg)?.message)}>
              <select id="sal-account" {...register('payAccountId')}>{accounts.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}</select>
            </Field>
          </div>
          {person && signOf(person.advance) === 1 && (
            <Field id="sal-rec" label={t('recover')} hint={t('recoverHint', { advance: inr2(person.advance) })} error={err((errors.advanceRecovered as ErrMsg)?.message)}>
              <input id="sal-rec" inputMode="decimal" autoComplete="off" className="num" {...register('advanceRecovered')} />
            </Field>
          )}
          {preview && (
            <p className="minfo" aria-live="polite">
              {t('salaryPreview', { gross: inr2(amount), recovered: inr2(preview.recovered), net: inr2(preview.net) })}
            </p>
          )}
          <p className="minfo">{t('salaryInfo')}</p>
        </>
      )}
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      <Actions pending={pending || salaried.length === 0} onCancel={onCancel} submitLabel={t('post')} />
    </form>
  );
}

function WagesForm({ people, accounts, today, personId, onDone, onCancel }: Props & { onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('staff');
  const te = useTranslations('errors');
  const label = useAccountLabel();
  const first = people.find((p) => p.id === personId && p.dailyWage);

  // One id per open of the modal (its content unmounts on close): a retry after a lost response is the same request, not a second one.
  const [requestId] = useState(() => crypto.randomUUID());
  const { register, handleSubmit, setValue, control, formState: { errors } } = useForm<WagesInput>({
    resolver: zodResolver(wagesSchema) as unknown as Resolver<WagesInput>,
    defaultValues: {
      id: requestId, voucherDate: today, employeeId: first?.id ?? '', payAccountId: defaultAccount(accounts), days: '', rate: first?.dailyWage ?? '', advanceRecovered: '', note: '',
    },
  });
  const date = useWatch({ control, name: 'voucherDate' });
  const employeeId = useWatch({ control, name: 'employeeId' });
  const days = String(useWatch({ control, name: 'days' }) ?? '');
  const rate = String(useWatch({ control, name: 'rate' }) ?? '');
  const person = people.find((p) => p.id === employeeId);
  const { pending, failure, run } = useSubmit(recordWages, onDone);
  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);
  const total = useMemo(() => (days && rate ? multiplyDays(days, rate) : null), [days, rate]);

  useEffect(() => {
    if (person?.dailyWage) setValue('rate', person.dailyWage);
  }, [person, setValue]);

  return (
    <form onSubmit={handleSubmit(run)} noValidate>
      <PersonField id="wg-emp" people={people} reg={register('employeeId')} error={err((errors.employeeId as ErrMsg)?.message)} blankLabel={t('casual')} />
      <div className="fieldrow">
        <Field id="wg-days" label={t('days')} error={err((errors.days as ErrMsg)?.message)}>
          <input id="wg-days" inputMode="decimal" autoComplete="off" className="num" {...register('days')} />
        </Field>
        <Field id="wg-rate" label={t('ratePerDay')} error={err((errors.rate as ErrMsg)?.message)}>
          <input id="wg-rate" inputMode="decimal" autoComplete="off" className="num" {...register('rate')} />
        </Field>
      </div>
      <div className="fieldrow">
        <Field id="wg-date" label={t('date')} className="datefield" error={err((errors.voucherDate as ErrMsg)?.message)}>
          <DateField id="wg-date" value={date} onChange={(iso) => setValue('voucherDate', iso, { shouldValidate: true })} placeholder="DD-MM-YYYY" />
        </Field>
        <Field id="wg-account" label={t('paidFrom')} error={err((errors.payAccountId as ErrMsg)?.message)}>
          <select id="wg-account" {...register('payAccountId')}>{accounts.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}</select>
        </Field>
      </div>
      {person && signOf(person.advance) === 1 && (
        <Field id="wg-rec" label={t('recover')} hint={t('recoverWagesHint', { advance: inr2(person.advance) })} error={err((errors.advanceRecovered as ErrMsg)?.message)}>
          <input id="wg-rec" inputMode="decimal" autoComplete="off" className="num" {...register('advanceRecovered')} />
        </Field>
      )}
      <Field id="wg-note" label={t('note')} error={err((errors.note as ErrMsg)?.message)}>
        <input id="wg-note" autoComplete="off" {...register('note')} />
      </Field>
      {total && signOf(total) === 1 && <p className="minfo" aria-live="polite">{t('wagesPreview', { total: inr2(total) })}</p>}
      <p className="minfo">{t('wagesInfo')}</p>
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      <Actions pending={pending} onCancel={onCancel} submitLabel={t('post')} />
    </form>
  );
}

/** Add an employee, or edit one's name, phone and pay rates (owner-only). */
export function EmployeeModal({ employee, triggerClassName = 'btn ghost' }: {
  employee?: { id: string; name: string; phone: string | null; monthlySalary: string | null; dailyWage: string | null };
  triggerClassName?: string;
}) {
  const t = useTranslations('staff');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => setOpen(true)}>{employee ? t('editEmployee') : `+ ${t('addEmployee')}`}</button>
      <Modal open={open} onClose={() => setOpen(false)} title={employee ? t('editEmployeeTitle') : t('addEmployeeTitle')} closeLabel={t('close')}>
        <EmployeeForm employee={employee} onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}

function EmployeeForm({ employee, onDone }: { employee?: { id: string; name: string; phone: string | null; monthlySalary: string | null; dailyWage: string | null }; onDone: () => void }) {
  const t = useTranslations('staff');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm<EmployeeInput>({
    resolver: zodResolver(createEmployeeSchema) as unknown as Resolver<EmployeeInput>,
    defaultValues: { name: employee?.name ?? '', phone: employee?.phone ?? '', monthlySalary: employee?.monthlySalary ?? '', dailyWage: employee?.dailyWage ?? '' },
  });
  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);
  const submit = handleSubmit((values) => {
    setFailure(null);
    start(async () => {
      const res = employee ? await updateEmployee({ id: employee.id, ...values }) : await createEmployee(values);
      if (!res.ok) return setFailure(res.error);
      router.refresh();
      onDone();
    });
  });
  return (
    <form onSubmit={submit} noValidate>
      <Field id="emp-name" label={t('name')} error={err((errors.name as ErrMsg)?.message)}>
        <input id="emp-name" autoComplete="off" {...register('name')} />
      </Field>
      <Field id="emp-phone" label={t('phone')} error={err((errors.phone as ErrMsg)?.message)}>
        <input id="emp-phone" inputMode="tel" autoComplete="off" {...register('phone')} />
      </Field>
      <div className="fieldrow">
        <Field id="emp-salary" label={t('monthlySalary')} hint={t('monthlySalaryHint')} error={err((errors.monthlySalary as ErrMsg)?.message)}>
          <input id="emp-salary" inputMode="decimal" autoComplete="off" className="num" {...register('monthlySalary')} />
        </Field>
        <Field id="emp-wage" label={t('dailyWage')} hint={t('dailyWageHint')} error={err((errors.dailyWage as ErrMsg)?.message)}>
          <input id="emp-wage" inputMode="decimal" autoComplete="off" className="num" {...register('dailyWage')} />
        </Field>
      </div>
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onDone}>{t('cancel')}</button>
        <button type="submit" className="btn primary" disabled={pending}>{t('save')}</button>
      </div>
    </form>
  );
}
