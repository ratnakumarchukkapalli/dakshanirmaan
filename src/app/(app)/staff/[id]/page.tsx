import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PartyStatusButton } from '@/components/parties/PartyStatusButton';
import { EmployeeModal, StaffActions } from '@/components/staff/StaffActions';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { LedgerTable, type LedgerTableRow } from '@/components/ui/LedgerTable';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { signOf } from '@/lib/decimal';
import { formatDate, inr, inr2 } from '@/lib/format';
import { loadEmployeeLedger, loadStaffList, summariseVouchers } from '@/lib/staff-data';
import { createClient } from '@/lib/supabase/server';

export default async function EmployeeLedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const member = await getCurrentMember();
  if (!isVerifiedAdmin(member)) redirect('/');
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [t, supabase] = await Promise.all([getTranslations('staff'), createClient()]);
  const ledger = await loadEmployeeLedger(supabase, id);
  if (!ledger) notFound();
  // The modals pick from every active person (advance / salary can be recorded for anyone from here too).
  const list = await loadStaffList(supabase);
  const people = list.employees.filter((e) => e.isActive).map((e) => ({ id: e.id, name: e.name, monthlySalary: e.monthlySalary, dailyWage: e.dailyWage, advance: e.advance }));
  const e = ledger.employee;

  const typeLabel = (v: string | null) => (v === 'advance' ? t('typeAdvance') : v === 'salary' ? t('typeSalary') : v === 'wages' ? t('typeWages') : null);
  const monthLabel = (iso: string) => new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  const money = (v: string) => (signOf(v) === 0 ? '' : inr2(v));
  const vouchers = summariseVouchers(ledger.rows);

  const columns = [
    { header: t('lcDate'), nowrap: true }, { header: t('lcVoucher'), nowrap: true }, { header: t('lcDetails') },
    { header: t('lcGiven'), numeric: true }, { header: t('lcRecovered'), numeric: true }, { header: t('lcAdvance'), numeric: true },
  ];
  const rows: LedgerTableRow[] = vouchers.map((v) => ({
    key: v.key,
    cells: [
      <span key="d" className="num">{formatDate(v.date)}</span>,
      <span key="v" className="mono">{v.docNo ?? '—'}</span>,
      <span key="n" className="muted">
        {typeLabel(v.voucherType) && <Chip tone="muted">{typeLabel(v.voucherType)}</Chip>}
        {v.reversal && <> <Chip tone="warn">{t('typeReversal')}</Chip></>}
        {v.periodMonth ? ` ${monthLabel(v.periodMonth)}` : ''}
        {v.gross !== null && v.paid !== null && <> · {t('grossPaid', { gross: inr2(v.gross), paid: inr2(v.paid) })}</>}
      </span>,
      money(v.advanceGiven), money(v.advanceRecovered), <b key="a">{inr2(v.advanceBalance)}</b>,
    ],
  }));

  return (
    <div className="screen stack">
      <div className="ledgerhead" style={{ marginBottom: 0 }}>
        <Link href="/staff" className="backbtn">← {t('backAll')}</Link>
        <div>
          <h1>{e.name}</h1>
          <span className="sub">
            {[e.monthlySalary && signOf(e.monthlySalary) === 1 ? t('perMonth', { amount: inr(e.monthlySalary) }) : null,
              e.dailyWage && signOf(e.dailyWage) === 1 ? t('perDay', { amount: inr(e.dailyWage) }) : null, e.phone].filter(Boolean).join(' · ')}
          </span>
        </div>
        {!e.isActive && <Chip tone="muted">{t('inactive')}</Chip>}
        <span className={`balpill num ${signOf(e.advance) === 1 ? 'warn' : 'good'}`}>
          {signOf(e.advance) === 1 ? t('advanceOs', { amount: inr2(e.advance) }) : t('settled')}
          {signOf(e.payable) === 1 && ` · ${t('payableOs', { amount: inr2(e.payable) })}`}
        </span>
      </div>
      <div className="headbtns" style={{ marginLeft: 0 }}>
        {e.isActive && <StaffActions people={people} accounts={ledger.accounts} today={ledger.today} personId={e.id} />}
        <EmployeeModal employee={{ id: e.id, name: e.name, phone: e.phone, monthlySalary: e.monthlySalary, dailyWage: e.dailyWage }} triggerClassName="btn ghost" />
      </div>

      <Card>
        {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>{t('ledgerEmpty')}</p> : <LedgerTable columns={columns} rows={rows} />}
        {ledger.truncated && <p className="alert warn" style={{ marginTop: 12 }}>{t('ledgerTruncated')}</p>}
      </Card>
      <p className="hint">{t('ledgerHint')}</p>
      <PartyStatusButton partyId={e.id} isActive={e.isActive} />
    </div>
  );
}
