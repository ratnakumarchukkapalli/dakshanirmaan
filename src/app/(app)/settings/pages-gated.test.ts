import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A layout is not re-run when the person moves between its pages, so every settings page carries its own
// owner-only gate (A3). This fails the build when a new settings page is added without one.
const root = __dirname;
const pages = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name === 'page.tsx' ? [full] : [];
  });

describe('settings pages', () => {
  const sub = pages(root).filter((f) => path.dirname(f) !== root); // /settings itself only redirects
  it('finds the sub-pages', () => expect(sub.length).toBeGreaterThanOrEqual(8));
  it.each(sub.map((f) => [path.relative(root, f), f]))('%s calls requireOwnerPage() before anything else', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    const body = src.slice(src.indexOf('export default async function'));
    const firstAwait = body.indexOf('await ');
    expect(body.indexOf('await requireOwnerPage()')).toBe(firstAwait);
  });
});
