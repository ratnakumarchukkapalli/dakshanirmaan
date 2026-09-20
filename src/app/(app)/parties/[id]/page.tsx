import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PartyModal } from '@/components/parties/PartyModal';
import { PartyStatusButton } from '@/components/parties/PartyStatusButton';
import { SitesPanel, type Site } from '@/components/parties/SitesPanel';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { KeyValue } from '@/components/ui/KeyValue';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { stateName } from '@/lib/gst';
import { inr } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';

// Master details and delivery sites. The ledger, ageing tiles and statements arrive with change 13.
export default async function PartyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [t, member, supabase] = await Promise.all([getTranslations('parties'), getCurrentMember(), createClient()]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [{ data: p }, { data: addresses }, { data: bal }, { data: org }] = await Promise.all([
    supabase.from('parties').select('*').eq('id', id).maybeSingle(),
    supabase.from('party_addresses').select('*').eq('party_id', id).order('created_at'),
    supabase.from('v_party_balances').select('ar_balance, ap_balance').eq('party_id', id).maybeSingle(),
    supabase.from('organization').select('state_code').maybeSingle(),
  ]);
  if (!p || p.type === 'employee') notFound();

  const isAdmin = isVerifiedAdmin(member);
  const sites: Site[] = (addresses ?? []).map((a) => {
    const ad = (a.address ?? {}) as Record<string, string | null>;
    return {
      id: a.id, label: a.label, line1: ad.line1 ?? '', line2: ad.line2 ?? null, city: ad.city ?? '', district: ad.district ?? null,
      pincode: ad.pincode ?? '', stateCode: a.state_code, isBilling: a.is_default,
    };
  });
  const typeLabel = { customer: t('typeCustomer'), supplier: t('typeSupplier'), both: t('typeBoth') } as const;
  const dash = '—';

  return (
    <div className="screen stack">
      <div className="screenhead" style={{ marginBottom: 0 }}>
        <h1>{p.name}</h1>
        <Chip tone={p.is_active ? 'good' : 'muted'}>{p.is_active ? t('active') : t('inactive')}</Chip>
        <span className="headbtns">
          <Link href="/parties" className="btn ghost sm">{t('back')}</Link>
          {!p.is_walk_in && (
            <PartyModal
              isAdmin={isAdmin}
              defaultStateCode={org?.state_code ?? '37'}
              triggerClassName="btn primary sm"
              party={{
                id: p.id, name: p.name, type: p.type, gstin: p.gstin, stateCode: p.state_code, phone: p.phone, whatsappPhone: p.whatsapp_phone,
                creditLimit: p.credit_limit == null ? null : String(p.credit_limit), creditDays: String(p.credit_days),
                interestRatePm: String(p.interest_rate_pm),
              }}
            />
          )}
        </span>
      </div>
      {!p.is_active && <p className="alert warn">{t('disabledNotice')}</p>}

      <Card>
        <div className="cardtitle">{t('details')}</div>
        <KeyValue
          rows={[
            { label: t('type'), value: typeLabel[p.type as keyof typeof typeLabel] },
            { label: t('gstin'), value: p.gstin ? <span className="mono">{p.gstin}</span> : dash },
            { label: t('state'), value: `${stateName(p.state_code)} (${p.state_code})` },
            { label: t('phone'), value: p.phone ?? dash },
            { label: t('whatsapp'), value: p.whatsapp_phone ?? dash },
            { label: t('toCollect'), value: Number(bal?.ar_balance ?? 0) ? inr(bal?.ar_balance) : dash },
            { label: t('toPay'), value: Number(bal?.ap_balance ?? 0) ? inr(bal?.ap_balance) : dash },
            { label: t('creditLimitField'), value: p.credit_limit == null ? t('noLimit') : Number(p.credit_limit) === 0 ? t('noCredit') : inr(p.credit_limit) },
            { label: t('creditDays'), value: String(p.credit_days) },
            { label: t('interestRate'), value: `${p.interest_rate_pm}%` },
          ]}
        />
      </Card>

      <SitesPanel partyId={p.id} sites={sites} defaultSiteId={p.default_site_id} defaultStateCode={p.state_code} />

      {isAdmin && !p.is_walk_in && <PartyStatusButton partyId={p.id} isActive={p.is_active} />}
    </div>
  );
}
