import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Acceptance (change 14): RSC by default, the chart is the only client component on the dashboard.
const files = [
  ...readdirSync(__dirname).filter((f) => /\.tsx$/.test(f)).map((f) => path.join(__dirname, f)),
  path.join(__dirname, '../../app/(app)/page.tsx'),
];

describe('dashboard client boundary', () => {
  it("only SalesChart is 'use client'", () => {
    const clients = files.filter((f) => /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8'))).map((f) => path.basename(f));
    expect(clients).toEqual(['SalesChart.tsx']);
  });
  it('no hex colour literal in the dashboard sources', () => {
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?!\w)/);
  });
});
