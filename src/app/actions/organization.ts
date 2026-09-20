'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import { requireAdmin } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import { organizationSchema } from '@/schemas/organization';

/** Owner-only. State and financial-year start are locked by the database once invoices exist. */
export async function updateOrganization(input: unknown): Promise<ActionResult> {
  const t = await getTranslations('errors');
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = organizationSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('organization')
    .update({
      legal_name: v.legalName, trade_name: v.tradeName ?? null, gstin: v.gstin ?? null, state_code: v.stateCode,
      address: {
        line1: v.address.line1, line2: v.address.line2 ?? null, city: v.address.city,
        district: v.address.district ?? null, pincode: v.address.pincode,
      },
      fy_start_month: Number(v.fyStartMonth),
      invoice_bank_details: v.invoiceBankDetails ?? null, upi_vpa: v.upiVpa ?? null, invoice_footer: v.invoiceFooter ?? null,
      einvoice_enabled: v.einvoiceEnabled, allow_negative_stock: v.allowNegativeStock,
    })
    .eq('singleton', true)
    .select('id');
  if (error) return dbFailure(error);
  if (!data?.length) return fail('forbidden', t('forbidden'));

  revalidatePath('/settings/organisation');
  revalidatePath('/', 'layout');
  return ok();
}
