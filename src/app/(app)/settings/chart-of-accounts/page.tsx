import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { requireOwnerPage } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';

interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  parent_id: string | null;
  is_group: boolean;
  system_key: string | null;
}

// Read-only: system accounts are wired into the posting engine and are not edited here.
export default async function ChartOfAccountsPage() {
  await requireOwnerPage();
  const t = await getTranslations('coa');
  const supabase = await createClient();
  const { data } = await supabase.from('accounts').select('id, code, name, type, parent_id, is_group, system_key').order('code');
  const accounts = (data ?? []) as Account[];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const depth = (a: Account): number => {
    let d = 0;
    for (let p = a.parent_id ? byId.get(a.parent_id) : undefined; p && d < 5; p = p.parent_id ? byId.get(p.parent_id) : undefined) d++;
    return d;
  };

  return (
    <div className="stack">
      <Card>
        <p className="muted" style={{ margin: '0 0 12px' }}>{t('subtitle')}</p>
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th>{t('code')}</th><th>{t('account')}</th><th>{t('type')}</th><th>{t('systemKey')}</th></tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.code}</td>
                  <td className={`${a.is_group ? 'pname ' : ''}coa-indent-${Math.min(depth(a), 2)}`}>{a.name}</td>
                  <td>{a.is_group ? <Chip tone="muted">{t('group')}</Chip> : t(a.type)}</td>
                  <td className="mono">{a.system_key ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
