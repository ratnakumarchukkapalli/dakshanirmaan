import 'server-only';
import { renderToBuffer } from '@react-pdf/renderer';
import { createTranslator } from 'next-intl';
import { NextResponse } from 'next/server';
import { getCurrentMember } from '@/lib/auth/current';
import { parseFyParam, fyStartYear } from '@/lib/fy';
import { todayIn } from '@/lib/format';
import { registerFonts } from '@/lib/invoice-pdf/fonts';
import { loadPartyLedger } from '@/lib/party-ledger';
import { createClient } from '@/lib/supabase/server';
import en from '@/messages/en.json';
import { statementDocument, type StatementLabels } from './StatementDocument';
import { buildStatementWorkbook, statementFilename } from './xlsx';

// GET /api/parties/[id]/statement.(xlsx|pdf)?fy=2026|all — the party statement.
// Any active member (an owner only after the authenticator step); row-level security decides what
// they can read. Statements are always in English, like the invoice PDF (the fonts are Latin).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (status: number, body: string) =>
  new NextResponse(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function statementResponse(id: string, fyParam: string | null, kind: 'xlsx' | 'pdf'): Promise<NextResponse> {
  if (!UUID.test(id)) return text(404, 'Not found');
  const member = await getCurrentMember();
  if (!member || (member.role === 'admin' && member.aal !== 'aal2')) return text(401, 'Sign in to download statements.');

  const supabase = await createClient();
  const { data: org, error: orgError } = await supabase.from('organization').select('legal_name, gstin, timezone').maybeSingle();
  if (orgError || !org) return text(500, 'Could not prepare the statement.');
  const fy = parseFyParam(fyParam, fyStartYear(todayIn(org.timezone ?? 'Asia/Kolkata')));

  let ledger;
  try {
    ledger = await loadPartyLedger(supabase, id, fy);
  } catch (e) {
    console.error('[statement] load failed:', e instanceof Error ? e.message : e);
    return text(500, 'Could not prepare the statement.');
  }
  if (!ledger) return text(404, 'Not found');

  const t = createTranslator({ locale: 'en', messages: en, namespace: 'statement' });
  // The loader stops at a page limit; a closing balance printed from a partial ledger would be wrong.
  if (ledger.truncated) return text(422, t('truncated'));
  const labels: StatementLabels = {
    title: t('title'), party: t('party'), gstin: t('gstin'), period: t('period'), allTime: t('allTime'), date: t('date'),
    document: t('document'), account: t('account'), details: t('details'), debit: t('debit'), credit: t('credit'),
    balance: t('balance'), broughtForward: t('broughtForward'), closing: t('closing'), receivable: t('receivable'),
    payable: t('payable'), reversal: t('reversal'), page: t('page'),
  };
  const orgInfo = { legalName: org.legal_name as string, gstin: (org.gstin as string | null) ?? null };
  const filename = statementFilename(ledger, kind);

  if (kind === 'xlsx') {
    const buf = await buildStatementWorkbook(ledger, orgInfo, labels);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  }
  registerFonts();
  const pdf = await renderToBuffer(statementDocument(ledger, orgInfo, labels));
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
