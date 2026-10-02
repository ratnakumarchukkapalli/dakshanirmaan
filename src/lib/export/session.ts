import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { requireExportOwner, textResponse } from './guard';
import { listFiscalYears, resolveFiscalYear } from './period';
import type { ExportContext } from './types';

/**
 * Everything an export route needs before it reads a single book: the gate (owner at aal2, else 403 with
 * no database read), the organisation, the financial year (`?fy=`, 400 when it is not one of the years
 * set up) and the as-of instant, captured once. Parts A, B and C all start here.
 */
export async function openExport(fyParam: string | null, fetchSite?: string | null): Promise<{ ctx: ExportContext; response?: undefined } | { ctx?: undefined; response: Response }> {
  const gate = await requireExportOwner(fetchSite);
  if (gate.denied) return { response: gate.denied };

  try {
    const supabase = await createClient();
    const org = await supabase.from('organization').select('legal_name, timezone').maybeSingle();
    if (org.error || !org.data) throw new Error(`organisation: ${org.error?.message ?? 'missing'}`);
    const timeZone = (org.data.timezone as string | null) ?? 'Asia/Kolkata';
    const fy = resolveFiscalYear(fyParam, await listFiscalYears(supabase), timeZone);
    if (!fy) return { response: textResponse(400, 'Choose a financial year that is set up in the books.') };
    return {
      ctx: { supabase, asOf: new Date().toISOString(), fy, timeZone, orgName: org.data.legal_name as string, generatedBy: gate.member.name },
    };
  } catch (e) {
    console.error('[export] could not open:', e instanceof Error ? e.message : e);
    return { response: textResponse(500, 'Could not prepare the export.') };
  }
}
