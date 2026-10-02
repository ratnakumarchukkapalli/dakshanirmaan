import { getTranslations } from 'next-intl/server';
import { ExportCards } from '@/components/settings/ExportCards';
import { ExportYearSelect } from '@/components/settings/ExportYearSelect';
import { requireOwnerPage } from '@/lib/auth/require';
import { listFiscalYears, resolveFiscalYear } from '@/lib/export/period';
import { fyName } from '@/lib/fy';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

// Export & backup: the three ways the books can leave the system (full-books Excel, Tally XML, year
// archive). Owners only: the proxy turns a counter session away, this page re-checks, and each route
// checks again and writes an audit row. Reading only; nothing here changes the books.
export default async function ExportPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const [t, ctx, supabase] = await Promise.all([getTranslations('settings.export'), getShellContext(), createClient()]);
  const years = await listFiscalYears(supabase);
  // An unknown ?fy= falls back to the default year rather than an error screen.
  const fy = resolveFiscalYear(sp.fy, years, ctx.timeZone) ?? resolveFiscalYear(null, years, ctx.timeZone);

  return (
    <div className="stack">
      <p className="hint" style={{ margin: 0 }}>{t('hint')}</p>
      {fy ? (
        <>
          <ExportYearSelect id="export-fy" label={t('yearLabel')} years={years.map((y) => ({ value: y, label: fyName(y) }))} value={fy.startYear} />
          <ExportCards fyStartYear={fy.startYear} />
        </>
      ) : (
        <p className="muted" style={{ margin: 0 }}>{t('noYears')}</p>
      )}
    </div>
  );
}
