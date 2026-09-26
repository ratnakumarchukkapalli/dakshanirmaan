import type { NextRequest } from 'next/server';
import { statementResponse } from '@/lib/statement/handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return statementResponse(id, request.nextUrl.searchParams.get('fy'), 'xlsx');
}
