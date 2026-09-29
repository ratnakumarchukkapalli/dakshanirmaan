import { BillForm } from '@/components/purchases/BillForm';
import { requireOwnerPage } from '@/lib/auth/require';
import { loadBillFormContext } from '@/lib/purchases-data';
import { createClient } from '@/lib/supabase/server';

export default async function NewBillPage() {
  await requireOwnerPage();
  const supabase = await createClient();
  const ctx = await loadBillFormContext(supabase);
  return <BillForm ctx={ctx} />;
}
