import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.join(__dirname, '../app/globals.css'), 'utf8');

/** Custom-property names declared inside the block that starts at `selector {`. */
function tokensIn(selector: string): string[] {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Block not found: ${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  return [...css.slice(open, end).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!).sort();
}

describe('theme tokens (theme fidelity)', () => {
  const dark = tokensIn(':root[data-theme=\'dark\']');
  const osDark = tokensIn(':root:not([data-theme=\'light\'])');
  const light = tokensIn(':root {');

  it('OS-dark and toggle-dark define exactly the same tokens', () => {
    expect(osDark).toEqual(dark);
  });
  it('dark redefines every colour token light defines (nothing stays light by accident)', () => {
    // Light-only tokens are the ones that do not change between themes.
    const themeIndependent = ['--glass-blur', '--r-outer', '--r-inner', '--r-chip', '--brand', '--brand-ink', '--brand-hi', '--brand-lo'];
    const mustChange = light.filter((t) => !themeIndependent.includes(t));
    expect(mustChange.filter((t) => !dark.includes(t))).toEqual([]);
  });
});

describe('reduced transparency', () => {
  it('makes .glass solid with no blur', () => {
    expect(css).toMatch(/prefers-reduced-transparency: reduce\)\s*\{\s*\.glass\s*\{[^}]*var\(--surface-solid\)[^}]*backdrop-filter: none/);
  });
});
