import type { NextRequest } from 'next/server';
import { tallyResponse } from '@/lib/export/tally-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The model is built from the owner's own client in pages of 1,000 rows; a year of 10,000 documents takes seconds. This only stops a runaway export.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  return tallyResponse(p.get('fy'), p.get('part'), p.get('company'), request.headers.get('sec-fetch-site'));
}
