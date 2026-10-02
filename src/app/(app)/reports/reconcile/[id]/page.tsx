import { getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { ReconTiles } from '@/components/bank/ReconTiles';
import { StatementLines } from '@/components/bank/StatementLines';
import { ReportError } from '@/components/reports/ReportHead';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Segmented';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { loadExpenseAccounts, loadFreeBookItems, loadRecon, loadStatement, loadStatementLines } from '@/lib/bank-data';
import { LINE_STATUSES, type LineStatus } from '@/lib/bank-types';
import { formatDate, inr2 } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import Link from 'next/link';

// One imported statement: its lines, what matched, and the actions that close the difference. Owner only.
export default async function StatementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const [t, tr, member, supabase] = await Promise.all([getTranslations('bank'), getTranslations('reports'), getCurrentMember(), createClient()]);
  if (!isVerifiedAdmin(member)) redirect('/reports');
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const filter = (LINE_STATUSES as readonly string[]).includes(sp.status ?? '') ? (sp.status as LineStatus) : null;

  let data: {
    statement: NonNullable<Awaited<ReturnType<typeof loadStatement>>>;
    recon: Awaited<ReturnType<typeof loadRecon>>;
    lines: Awaited<ReturnType<typeof loadStatementLines>>;
    items: Awaited<ReturnType<typeof loadFreeBookItems>>;
    accounts: Awaited<ReturnType<typeof loadExpenseAccounts>>;
  } | null = null;
  try {
    const statement = await loadStatement(supabase, id);
    if (!statement) notFound();
    const [recon, lines, items, accounts] = await Promise.all([
      loadRecon(supabase), loadStatementLines(supabase, id), loadFreeBookItems(supabase), loadExpenseAccounts(supabase),
    ]);
    data = { statement, recon, lines, items, accounts };
  } catch (e) {
    // notFound() throws a control-flow error that must reach Next.js.
    if (e && typeof e === 'object' && 'digest' in e) throw e;
    console.error('[bank] statement page failed:', e instanceof Error ? e.message : e);
  }

  const base = `/reports/reconcile/${id}`;
  const counts = (s: LineStatus) => data?.lines.filter((l) => l.status === s).length ?? 0;
  const shown = data ? (filter ? data.lines.filter((l) => l.status === filter) : data.lines) : [];

  return (
    <div className="screen">
      <Link href="/reports/reconcile" className="backbtn">← {t('title')}</Link>
      <div className="screenhead">
        <h1>{data ? `${formatDate(data.statement.periodFrom)} → ${formatDate(data.statement.periodTo)}` : t('statementTitle')}</h1>
        {data?.statement.sourceFile && <span className="sub" style={{ overflowWrap: 'anywhere' }}>{data.statement.sourceFile}</span>}
      </div>
      {!data ? (
        <ReportError message={tr('loadError')} />
      ) : (
        <div className="stack">
          <ReconTiles recon={data.recon} unmatchedLines={data.statement.unmatchedCount} />
          {data.recon?.statementId && data.recon.statementId !== id && <p className="hint" style={{ margin: 0 }}>{t('notLatest')}</p>}
          <p className="hint" style={{ margin: 0 }}>
            {t('statementFacts', {
              rows: data.statement.lineCount,
              opening: data.statement.openingBalance === null ? '—' : inr2(data.statement.openingBalance),
              closing: data.statement.closingBalance === null ? '—' : inr2(data.statement.closingBalance),
            })}
          </p>
          <Card>
            <div className="toolbar">
              <Segmented
                label={t('filterLabel')}
                active={filter ?? 'all'}
                options={[
                  { key: 'all', label: `${t('filterAll')} (${data.lines.length})`, href: base },
                  ...LINE_STATUSES.map((s) => ({ key: s, label: `${t(`status.${s}`)} (${counts(s)})`, href: `${base}?status=${s}` })),
                ]}
              />
            </div>
            <StatementLines
              statementId={id}
              lines={shown}
              bookItems={data.items}
              expenseAccounts={data.accounts}
              canAutoMatch={data.statement.unmatchedCount > 0}
            />
          </Card>
        </div>
      )}
    </div>
  );
}
