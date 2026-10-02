import { getTranslations } from 'next-intl/server';
import { ReportFilters } from '@/components/reports/ReportFilters';
import { Card } from '@/components/ui/Card';
import { auditDetails } from '@/lib/audit-view';
import { requireOwnerPage } from '@/lib/auth/require';
import { rows } from '@/lib/db';
import { addDaysIso } from '@/lib/dashboard-math';
import { formatDate, todayIn } from '@/lib/format';
import { validIso } from '@/lib/reports-math';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

const LIMIT = 200;

interface AuditRow { id: string; at: string; actor: string | null; action: string; entity: string; entity_id: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }

// The audit trail: who posted, cancelled, locked or edited what (owners only; the settings layout is the first lock,
// the database policy on audit_log the second). Newest first, at most 200 rows, filtered in the URL.
export default async function AuditTrailPage({ searchParams }: { searchParams: Promise<{ entity?: string; actor?: string; from?: string; to?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const [t, tr, ctx, supabase] = await Promise.all([
    getTranslations('settings.audit'), getTranslations('reports'), getShellContext(), createClient(),
  ]);
  const from = validIso(sp.from);
  const to = validIso(sp.to);
  const entities = Object.keys(t.raw('entities') as Record<string, string>);
  const entity = sp.entity && entities.includes(sp.entity) ? sp.entity : '';

  const peopleRes = await supabase.from('app_users').select('user_id, name').order('name');
  const people = rows<{ user_id: string; name: string }>(peopleRes, 'people');
  const actor = sp.actor && people.some((p) => p.user_id === sp.actor) ? sp.actor : '';

  let q = supabase.from('audit_log').select('id, at, actor, action, entity, entity_id, before, after').order('at', { ascending: false }).limit(LIMIT);
  if (entity) q = q.eq('entity', entity);
  if (actor) q = q.eq('actor', actor);
  // Business dates are in the organisation's zone; the range is generous by a day on each side and trimmed below.
  if (from) q = q.gte('at', `${addDaysIso(from, -1)}T00:00:00Z`);
  if (to) q = q.lt('at', `${addDaysIso(to, 2)}T00:00:00Z`);
  const list = rows<AuditRow>(await q, 'audit log').filter((r) => {
    const day = todayIn(ctx.timeZone, new Date(r.at));
    return (!from || day >= from) && (!to || day <= to);
  });

  const who = new Map(people.map((p) => [p.user_id, p.name]));
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: ctx.timeZone });
  const label = (ns: 'actions' | 'entities', key: string) => (t.has(`${ns}.${key}`) ? t(`${ns}.${key}`) : key);

  return (
    <div className="stack">
      <p className="hint" style={{ margin: 0 }}>{t('hint')}</p>
      <ReportFilters
        dates={[{ name: 'from', label: t('from'), value: from ?? '' }, { name: 'to', label: t('to'), value: to ?? '' }]}
        select={[
          { name: 'entity', label: t('filterEntity'), value: entity, options: [{ value: '', label: t('all') }, ...entities.map((e) => ({ value: e, label: label('entities', e) }))] },
          { name: 'actor', label: t('filterPerson'), value: actor, options: [{ value: '', label: t('all') }, ...people.map((p) => ({ value: p.user_id, label: p.name }))] },
        ]}
        datePlaceholder={tr('datePlaceholder')}
        submitLabel={t('show')}
      />
      <Card>
        {list.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead><tr><th>{t('colWhen')}</th><th>{t('colWho')}</th><th>{t('colAction')}</th><th>{t('colWhat')}</th><th>{t('colDetails')}</th></tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{formatDate(todayIn(ctx.timeZone, new Date(r.at)))} {time.format(new Date(r.at))}</td>
                    <td>{r.actor ? (who.get(r.actor) ?? '—') : t('system')}</td>
                    <td>{label('actions', r.action)}</td>
                    <td>{label('entities', r.entity)}</td>
                    <td>
                      {auditDetails(r.action, r.before, r.after).map((d) => (
                        <div key={d.key} className="sub">
                          {d.before !== undefined ? t('changed', { key: d.key, before: d.before, after: d.after ?? '' }) : `${d.key}: ${d.after}`}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
