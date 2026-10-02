import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Acceptance (change 15): RSC by default; only the form pieces are client components.
const dir = __dirname;
const pages = ['', 'day-close', 'day-book', 'aging', 'stock', 'cash-bank', 'reconcile', 'reconcile/[id]'].map((p) => path.join(dir, '../../app/(app)/reports', p, 'page.tsx'));
const components = readdirSync(dir).filter((f) => /\.tsx$/.test(f)).map((f) => path.join(dir, f));

describe('reports client boundary', () => {
  it("only the counted-cash form, the reopen button and the date filters are 'use client'", () => {
    const clients = components.filter((f) => /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8'))).map((f) => path.basename(f)).sort();
    expect(clients).toEqual(['DayCloseForm.tsx', 'ReopenDay.tsx', 'ReportFilters.tsx']);
  });
  it('every report page is a server component', () => {
    for (const f of pages) expect(readFileSync(f, 'utf8'), f).not.toMatch(/^\s*['"]use client['"]/);
  });
  it('no hex colour literal in the report sources', () => {
    for (const f of [...components, ...pages]) expect(readFileSync(f, 'utf8'), f).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?!\w)/);
  });
  it('owner-only figures are only fetched behind an owner check', () => {
    const cash = readFileSync(pages[5]!, 'utf8');
    expect(cash).toMatch(/if \(!isVerifiedAdmin\(member\)\) redirect\('\/reports'\)/);
    expect(readFileSync(pages[0]!, 'utf8')).toMatch(/isAdmin \|\| !c\.ownerOnly/);
    for (const f of [pages[6]!, pages[7]!]) expect(readFileSync(f, 'utf8'), f).toMatch(/if \(!isVerifiedAdmin\(member\)\) redirect\('\/reports'\)/);
  });
});
