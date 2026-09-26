import type { NextRequest } from 'next/server';
import { reportXlsxResponse } from '@/lib/reports/handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return reportXlsxResponse(name, request.nextUrl.searchParams);
}
