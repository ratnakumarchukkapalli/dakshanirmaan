import { OrganizationForm } from '@/components/settings/OrganizationForm';
import { createClient } from '@/lib/supabase/server';

export default async function OrganisationPage() {
  const supabase = await createClient();
  const { data: o } = await supabase.from('organization').select('*').maybeSingle();
  const a = (o?.address ?? {}) as Record<string, string | null>;
  return (
    <OrganizationForm
      initial={{
        legalName: o?.legal_name ?? '', tradeName: o?.trade_name ?? '', gstin: o?.gstin ?? '', stateCode: o?.state_code ?? '37',
        address: { line1: a.line1 ?? '', line2: a.line2 ?? '', city: a.city ?? '', district: a.district ?? '', pincode: a.pincode ?? '' },
        fyStartMonth: '4', invoiceBankDetails: o?.invoice_bank_details ?? '',
        upiVpa: o?.upi_vpa ?? '', invoiceFooter: o?.invoice_footer ?? '',
        einvoiceEnabled: !!o?.einvoice_enabled, allowNegativeStock: !!o?.allow_negative_stock,
      }}
    />
  );
}
