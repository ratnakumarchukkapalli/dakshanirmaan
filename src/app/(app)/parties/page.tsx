import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { PartyModal } from '@/components/parties/PartyModal';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { SearchInput } from '@/components/ui/SearchInput';
import { Segmented } from '@/components/ui/Segmented';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { inr2 } from '@/lib/format';
import { cleanSearchText, orContainsFilter } from '@/lib/search';
import { createClient } from '@/lib/supabase/server';

type Segment = 'all' | 'customer' | 'supplier';

export default async function PartiesPage({ searchParams }: { searchParams: Promise<{ type?: string; q?: string }> }) {
  const sp = await searchParams;
  const segment: Segment = sp.type === 'customer' || sp.type === 'supplier' ? sp.type : 'all';
  const q = cleanSearchText(sp.q);

  const [t, member, supabase] = await Promise.all([getTranslations('parties'), getCurrentMember(), createClient()]);

  let query = supabase.from('parties').select('id, name, type, gstin, credit_limit, is_active').neq('type', 'employee').order('name');
  if (segment === 'customer') query = query.in('type', ['customer', 'both']);
  if (segment === 'supplier') query = query.in('type', ['supplier', 'both']);
  // The typed text is escaped for both LIKE and PostgREST (see lib/search.ts), so it cannot alter the filter.
  const filter = orContainsFilter(['name', 'gstin'], q);
  if (filter) query = query.or(filter);

  const [{ data: parties }, { data: balances }, { data: org }] = await Promise.all([
    query,
    supabase.from('v_party_balances').select('party_id, ar_balance, ap_balance'),
    supabase.from('organization').select('state_code').maybeSingle(),
  ]);
  const balanceOf = new Map((balances ?? []).map((b) => [b.party_id as string, b]));

  const href = (type: Segment) => {
    const params = new URLSearchParams();
    if (type !== 'all') params.set('type', type);
    if (q) params.set('q', q);
    const s = params.toString();
    return s ? `/parties?${s}` : '/parties';
  };
  const typeLabel = { customer: t('typeCustomer'), supplier: t('typeSupplier'), both: t('typeBoth') } as const;

  return (
    <div className="screen">
      <div className="screenhead">
        <h1>{t('title')}</h1>
        <span className="sub">{t('subtitle')}</span>
        <span className="headbtns">
          <PartyModal isAdmin={isVerifiedAdmin(member)} defaultStateCode={org?.state_code ?? '37'} />
        </span>
      </div>
      <div className="toolbar">
        <Segmented
          label={t('segments')}
          active={segment}
          options={[
            { key: 'all', label: t('all'), href: href('all') },
            { key: 'customer', label: t('customers'), href: href('customer') },
            { key: 'supplier', label: t('suppliers'), href: href('supplier') },
          ]}
        />
        <SearchInput name="q" defaultValue={q} label={t('searchLabel')} placeholder={t('searchPlaceholder')} buttonLabel={t('searchButton')} keep={{ type: segment === 'all' ? undefined : segment }} />
      </div>
      <Card>
        {(parties ?? []).length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>{t('party')}</th><th className="r">{t('toCollect')}</th><th className="r">{t('toPay')}</th>
                  <th className="r">{t('creditLimit')}</th><th>{t('status')}</th>
                </tr>
              </thead>
              <tbody>
                {(parties ?? []).map((p) => {
                  const b = balanceOf.get(p.id);
                  const ar = Number(b?.ar_balance ?? 0);
                  const ap = Number(b?.ap_balance ?? 0);
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="pname"><Link href={`/parties/${p.id}`}>{p.name}</Link></div>
                        <div className="sub">{[typeLabel[p.type as keyof typeof typeLabel], p.gstin].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td className="r num">{ar ? inr2(ar) : '—'}</td>
                      <td className="r num">{ap ? inr2(ap) : '—'}</td>
                      <td className="r num">{p.credit_limit == null ? t('noLimit') : Number(p.credit_limit) === 0 ? t('noCredit') : inr2(p.credit_limit)}</td>
                      <td><Chip tone={p.is_active ? 'good' : 'muted'}>{p.is_active ? t('active') : t('inactive')}</Chip></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
