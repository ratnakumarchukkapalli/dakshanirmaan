import type { NextRequest } from 'next/server';
import { booksResponse } from '@/lib/export/books-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Measured locally: ~6,000 journal lines stream in about 2 s, so a year of 10,000 documents takes well under a minute; this only stops a runaway export.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  return booksResponse(request.nextUrl.searchParams.get('fy'), request.headers.get('sec-fetch-site'));
}
