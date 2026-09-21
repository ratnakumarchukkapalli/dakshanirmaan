import { renderToBuffer } from '@react-pdf/renderer';
import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentMember } from '@/lib/auth/current';
import { pickClientIp } from '@/lib/auth/client-ip';
import { createLimiter } from '@/lib/auth/rate-limit';
import { registerFonts } from '@/lib/invoice-pdf/fonts';
import { loadInvoicePdfData } from '@/lib/invoice-pdf/data';
import { invoiceDocument } from '@/lib/invoice-pdf/InvoiceDocument';
import { qrDataUrl, upiUri } from '@/lib/invoice-pdf/upi';
import { verifyInvoiceLink } from '@/lib/share-link';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

// GET /api/invoices/[id]/pdf — the GST tax invoice.
//  * signed in: any active member (an owner only after the authenticator step); row-level security decides.
//  * signed link (?exp=&sig=): the WhatsApp share. Checked in constant time first; only then is that
//    ONE invoice read with the service client. Every refusal is the same bare status, no detail.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Bad signatures from one address: a brute-force spray is cut off long before it could matter.
const badLinks = createLimiter({ limit: 20, windowMs: 10 * 60 * 1000 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (status: number, body: string) => new NextResponse(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return text(404, 'Not found');

  const sig = request.nextUrl.searchParams.get('sig');
  let supabase;
  if (sig !== null) {
    const ip = pickClientIp((name) => request.headers.get(name));
    if (!badLinks.allows(ip)) return text(429, 'Too many requests');
    const check = verifyInvoiceLink(id, request.nextUrl.searchParams.get('exp'), sig, process.env.INVOICE_LINK_SECRET);
    if (check !== 'ok') {
      badLinks.hit(ip);
      return text(403, 'This link is not valid.');
    }
    supabase = createAdminClient();
  } else {
    const member = await getCurrentMember();
    if (!member || (member.role === 'admin' && member.aal !== 'aal2')) return text(401, 'Sign in to download invoices.');
    supabase = await createClient();
  }

  const result = await loadInvoicePdfData(supabase, id);
  if (result.kind === 'not_found') return text(404, 'Not found');
  if (result.kind === 'draft') return text(409, 'This invoice is still a draft. Post it to get an invoice PDF.');
  if (result.kind === 'error') return text(500, 'Could not prepare the invoice.');
  const { data } = result;

  const wantsQr = !data.cancelled && data.open !== '0.00' && !!data.org.upiVpa;
  const qr = wantsQr
    ? await qrDataUrl(upiUri({ vpa: data.org.upiVpa!, name: data.org.legalName, amount: data.open, note: data.number }))
    : null;

  registerFonts();
  const pdf = await renderToBuffer(invoiceDocument(data, qr));
  const filename = `DN-${data.number.replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`;
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
