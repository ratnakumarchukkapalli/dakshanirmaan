import type { NextRequest } from 'next/server';
import { archiveResponse } from '@/lib/export/archive-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Measured locally (see openspec/changes/25-exports-portability/implementation-notes.md, "Parts B and C"): a year of a few
// thousand documents takes seconds; this ceiling is for the 10,000-document year and stops a runaway export.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  return archiveResponse(request.nextUrl.searchParams.get('fy'));
}
