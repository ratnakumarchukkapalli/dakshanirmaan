import { InvoiceForm } from '@/components/sales/InvoiceForm';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { loadInvoiceFormContext } from '@/lib/sales-data';
import { createClient } from '@/lib/supabase/server';

export default async function NewInvoicePage() {
  const supabase = await createClient();
  const [member, ctx] = await Promise.all([getCurrentMember(), loadInvoiceFormContext(supabase)]);
  return <InvoiceForm ctx={ctx} isAdmin={isVerifiedAdmin(member)} />;
}
