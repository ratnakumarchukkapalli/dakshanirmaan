import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { RowLink } from '@/components/sales/RowLink';
import { EmployeeModal, StaffActions } from '@/components/staff/StaffActions';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { StatTile } from '@/components/ui/StatTile';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { signOf } from '@/lib/decimal';
import { inr } from '@/lib/format';
import { loadStaffList } from '@/lib/staff-data';
import { createClient } from '@/lib/supabase/server';

// Staff and salaries: OWNER-ONLY. A counter session is turned away here (and by the proxy, and the
// database returns it no pay data at all).
export default async function StaffPage() {
  const member = await getCurrentMember();
  if (!isVerifiedAdmin(member)) redirect('/');
  const [t, supabase] = await Promise.all([getTranslations('staff'), createClient()]);
  const s = await loadStaffList(supabase);
  const monthName = new Intl.DateTimeFormat('en-IN', { month: 'long', timeZone: 'UTC' }).format(new Date(`${s.monthStart}T00:00:00Z`));
  const active = s.employees.filter((e) => e.isActive);
  const people = active.map((e) => ({ id: e.id, name: e.name, monthlySalary: e.monthlySalary, dailyWage: e.dailyWage, advance: e.advance }));

  return (
    <div className="screen">
      <div className="screenhead">
        <h1>{t('title')}</h1>
        <span className="sub">{t('subtitle')}</span>
        <span className="headbtns">
          <StaffActions people={people} accounts={s.accounts} today={s.today} />
          <EmployeeModal />
        </span>
      </div>

      <div className="tiles">
        <StatTile label={t('tileBill')} value={inr(s.tiles.salaryBill)} sub={t('tileBillSub', { salaried: s.tiles.salaried, wages: s.tiles.wageWorkers })} small />
        <StatTile label={t('tileAdvances')} value={inr(s.tiles.advances)} sub={t('tileAdvancesSub')} tone={signOf(s.tiles.advances) === 1 ? 'warn' : undefined} small />
        <StatTile label={t('tilePaid', { month: monthName })} value={inr(s.tiles.paidThisMonth)} sub={t('tilePaidSub')} small />
      </div>

      <Card>
        {s.employees.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>{t('colName')}</th><th>{t('colPay')}</th><th className="r">{t('colAdvance')}</th><th>{t('colStatus')}</th></tr>
              </thead>
              <tbody>
                {s.employees.map((e) => (
                  <RowLink key={e.id} href={`/staff/${e.id}`}>
                    <td>
                      <div className="pname"><Link href={`/staff/${e.id}`}>{e.name}</Link></div>
                      {e.phone && <div className="sub">{e.phone}</div>}
                    </td>
                    <td className="num">
                      {e.monthlySalary && signOf(e.monthlySalary) === 1 ? t('perMonth', { amount: inr(e.monthlySalary) }) : e.dailyWage && signOf(e.dailyWage) === 1 ? t('perDay', { amount: inr(e.dailyWage) }) : '—'}
                    </td>
                    <td className="r num">{signOf(e.advance) === 1 ? inr(e.advance) : '—'}</td>
                    <td>
                      {!e.isActive ? <Chip tone="muted">{t('inactive')}</Chip>
                        : signOf(e.advance) === 1 ? <Chip tone="warn">{t('advanceChip', { amount: inr(e.advance) })}</Chip>
                        : signOf(e.payable) === 1 ? <Chip tone="bad">{t('payableChip', { amount: inr(e.payable) })}</Chip>
                        : <Chip tone="good">{t('settled')}</Chip>}
                    </td>
                  </RowLink>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="hint">{t('hint')}</p>
    </div>
  );
}
