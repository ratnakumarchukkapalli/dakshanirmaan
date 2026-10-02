import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_READY, exportHref } from '@/lib/export/kinds';
import en from '@/messages/en.json';
import te from '@/messages/te.json';

// The Export & backup screen (change 25, part D): owner-only like the other settings tabs, three cards,
// all three cards live (the Tally card with its two downloads); a kind that is not ready is a disabled button.

const lookup = (ns: string, key: string): string => {
  const v = [...ns.split('.'), ...key.split('.')].reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);
  if (typeof v !== 'string') throw new Error(`missing message ${ns}.${key}`);
  return v;
};
vi.mock('next-intl/server', () => ({ getTranslations: async (ns: string) => (key: string) => lookup(ns, key) }));

const here = __dirname;
const read = (rel: string) => readFileSync(path.join(here, rel), 'utf8');
const originalReady = { ...EXPORT_READY };
afterEach(() => Object.assign(EXPORT_READY, originalReady));

async function cards(year = 2026) {
  const { ExportCards } = await import('./ExportCards');
  return renderToStaticMarkup(await ExportCards({ fyStartYear: year }));
}

describe('ExportCards', () => {
  it('shows the three cards with a plain sentence each', async () => {
    const html = await cards();
    for (const k of ['books', 'tally', 'archive'] as const) {
      expect(html).toContain(lookup('settings.export', `${k}.title`).replace('&', '&amp;'));
      expect(html).toContain(lookup('settings.export', `${k}.body`).replace(/'/g, '&#x27;'));
    }
  });

  it('links the full-books card to the route, opening in its own tab', async () => {
    const html = await cards(2025);
    expect(html).toContain('href="/api/backup/books.xlsx?fy=2025"');
    expect(html).toMatch(/<a[^>]*target="_blank"[^>]*rel="noopener"/);
  });

  it('all three cards are live: the books, the archive and the two Tally files', async () => {
    expect(EXPORT_READY).toEqual({ books: true, tally: true, archive: true });
    const html = await cards(2025);
    expect(html).toContain('href="/api/backup/archive.zip?fy=2025"');
    expect(html).not.toContain('Coming next');
    expect(html).not.toContain('aria-disabled');
    expect(exportHref('books', 2025)).toBe('/api/backup/books.xlsx?fy=2025');
  });

  it('the Tally card offers the ledgers file and then the vouchers file, each opening in its own tab', async () => {
    const html = await cards(2026);
    const ledgers = html.indexOf('href="/api/reports/tally.xml?fy=2026&amp;part=masters"');
    const vouchers = html.indexOf('href="/api/reports/tally.xml?fy=2026&amp;part=vouchers"');
    expect(ledgers).toBeGreaterThan(0);
    expect(vouchers).toBeGreaterThan(ledgers);
    expect(html.indexOf('1. Ledgers file')).toBeGreaterThan(0);
    expect(html.indexOf('2. Vouchers file')).toBeGreaterThan(html.indexOf('1. Ledgers file'));
    expect(html.match(/<a[^>]*tally\.xml[^>]*target="_blank"[^>]*rel="noopener"/g)).toHaveLength(2);
    expect(exportHref('tally', 2026, 'masters')).toBe('/api/reports/tally.xml?fy=2026&part=masters');
    expect(exportHref('tally', 2026)).toBe('/api/reports/tally.xml?fy=2026');
  });

  it('tells the owner to import the ledgers first and to switch Tally to Manual numbering to keep our voucher numbers', async () => {
    const html = await cards();
    expect(html).toContain('the ledgers first, then the vouchers');
    expect(html).toContain('Manual numbering');
    expect(html).toContain('narration');
  });

  it('a kind that is not ready shows a disabled "coming next" button instead of a link to a missing route', async () => {
    EXPORT_READY.tally = false;
    EXPORT_READY.archive = false;
    const html = await cards();
    expect(html).not.toContain('/api/reports/tally.xml');
    expect(html).not.toContain('/api/backup/archive.zip');
    expect(html.match(/<button[^>]*disabled[^>]*>Coming next<\/button>/g) ?? []).toHaveLength(2);
    expect(html).toContain('aria-disabled="true"');
  });

  it('carries the honest Tally note on its card', async () => {
    const html = await cards();
    expect(html).toContain("Generated to Tally&#x27;s documented import format; not yet imported into a live Tally. Ask your CA to test-import on a copy company first.");
  });
});

describe('ExportCards: accessibility and tidy markup', () => {
  it('every download link says in hidden text that it opens in a new tab, in both languages', async () => {
    const html = await cards();
    expect(html.match(/class="vh"> \(opens in a new tab\)/g)).toHaveLength(4); // books, ledgers, vouchers, archive
    expect(te.settings.export.newTab).toBeTruthy();
    expect(te.settings.export.newTab).not.toBe(en.settings.export.newTab);
    expect(read('../../app/globals.css')).toMatch(/\.vh \{[^}]*clip-path/);
  });

  it('tells the CA that inventory comes in under Current Assets', async () => {
    expect(await cards()).toContain('not Stock-in-Hand');
    expect(te.settings.export.tally.inventory).toBeTruthy();
  });

  it('has no inline styles', () => {
    expect(read('ExportCards.tsx')).not.toMatch(/style=\{/);
  });
});

describe('Export & backup screen guards and wiring', () => {
  const page = read('../../app/(app)/settings/export/page.tsx');

  it('the page re-checks for an owner at aal2 before reading anything, and the settings layout and proxy do too', () => {
    expect(page).toMatch(/await requireOwnerPage\(\);/);
    expect(page.indexOf('requireOwnerPage()')).toBeLessThan(page.indexOf('createClient()'));
    expect(read('../../app/(app)/settings/layout.tsx')).toMatch(/isVerifiedAdmin/);
    expect(read('../../lib/access.ts')).toMatch(/isSettingsPath\(pathname\)/);
  });

  it('is a tab of the settings navigation', () => {
    expect(read('SettingsTabs.tsx')).toContain("href: '/settings/export'");
  });

  it('only the year select is a client component, and no source has a hex colour', () => {
    const clients = readdirSync(here).filter((f) => /^Export.*\.tsx$/.test(f) && /^\s*['"]use client['"]/.test(read(f)));
    expect(clients).toEqual(['ExportYearSelect.tsx']);
    for (const f of ['ExportCards.tsx', 'ExportYearSelect.tsx', '../../app/(app)/settings/export/page.tsx']) expect(read(f), f).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?!\w)/);
  });

  it('English and Telugu have the same keys for the screen, the tab and the audit labels', () => {
    const keys = (o: unknown, prefix = ''): string[] =>
      o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => keys(v, `${prefix}${k}.`)) : [prefix.slice(0, -1)];
    const pick = (m: typeof en) => ({ screen: m.settings.export, tab: m.settings.tabs.export, action: m.settings.audit.actions.export, entities: [m.settings.audit.entities.books, m.settings.audit.entities.tally, m.settings.audit.entities.archive] });
    expect(keys(pick(te)).sort()).toEqual(keys(pick(en)).sort());
    expect(te.settings.export.tally.note).toBeTruthy();
    expect(te.settings.export.tally.note).not.toBe(en.settings.export.tally.note);
  });
});
