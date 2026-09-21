import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.join(__dirname, '../app/globals.css'), 'utf8');

/** The text between the braces of the block that starts at `selector {`. */
function blockBody(selector: string): string {
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
  return css.slice(open + 1, end);
}

/** Custom-property names declared inside the block that starts at `selector {`. */
function tokensIn(selector: string): string[] {
  return [...blockBody(selector).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!).sort();
}

/** Custom-property values by name, whitespace-normalised. */
function valuesIn(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of blockBody(selector).matchAll(/(--[a-z0-9-]+)\s*:([^;]*);/g)) out[m[1]!] = m[2]!.replace(/\s+/g, ' ').trim();
  return out;
}

const DARK = ':root[data-theme=\'dark\']';
const OS_DARK = ':root:not([data-theme=\'light\'])';

describe('theme tokens (theme fidelity)', () => {
  const dark = tokensIn(DARK);
  const osDark = tokensIn(OS_DARK);
  const light = tokensIn(':root {');

  it('OS-dark and toggle-dark define exactly the same tokens with exactly the same values', () => {
    expect(osDark).toEqual(dark);
    const normalise = (selector: string) => blockBody(selector).replace(/\s+/g, ' ').trim();
    expect(normalise(OS_DARK)).toEqual(normalise(DARK));
    expect(valuesIn(OS_DARK)).toEqual(valuesIn(DARK));
  });
  it('dark really is different from light for the core colour tokens', () => {
    const lightValues = valuesIn(':root {');
    const darkValues = valuesIn(DARK);
    for (const token of ['--bg', '--ink', '--glass', '--surface', '--accent']) {
      expect(lightValues[token], `${token} in light`).toBeTruthy();
      expect(darkValues[token], `${token} in dark`).toBeTruthy();
      expect(darkValues[token], `${token} must differ`).not.toEqual(lightValues[token]);
    }
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
