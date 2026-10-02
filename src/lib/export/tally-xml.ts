import { fromScaled } from './decimal';

// Text and number rules of the Tally XML files (docs/research/tally-xml-format.md, sections 4 and 6).
// Pure functions: nothing here reads the books.

/** Tally's ledger-name limit as far as the research could tell (UI limit; UNVERIFIED). */
export const LEDGER_NAME_MAX = 75;
/** Our own cap for a narration. The research found no limit; this keeps a pasted essay out of a voucher. */
export const NARRATION_MAX = 500;

// XML 1.0 cannot hold C0 controls other than tab/LF/CR, the two non-characters, or a lone surrogate.
// C1 controls (0x7F-0x9F) are legal but discouraged and Tally has been seen to choke on them: removed too.
// So are the emoji variation selectors, which mean nothing once the emoji itself is gone.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFE0E\uFE0F\uFFFE\uFFFF]/g;
// Astral characters (emoji) and lone surrogates: the research says to keep them out of names and narrations.
const ASTRAL = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/** Removes what XML cannot carry; emoji and other astral characters become a space. */
export function cleanText(value: string): string {
  return value.replace(CONTROL, '').replace(ASTRAL, ' ');
}

/** One line of clean text: tabs and line breaks become a space, runs of spaces collapse, ends are trimmed. */
export function singleLine(value: string): string {
  return cleanText(value).replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Cuts to at most `max` characters without leaving a Telugu (or other) combining mark orphaned at the end. */
export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  while (end > 0 && /\p{M}/u.test(value.charAt(end))) end -= 1;
  return value.slice(0, end || max).trimEnd();
}

/** Text between tags: `&`, `<` and `>` escaped. A raw `&` makes Tally reject the whole file. */
export const xmlText = (value: string): string => cleanText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Text inside a double-quoted attribute. */
export const xmlAttr = (value: string): string => xmlText(value).replace(/"/g, '&quot;');

/** How Tally compares ledger names: case-insensitive, spaces collapsed, hyphen = space = slash. */
export const foldName = (name: string): string => name.toLowerCase().replace(/[-/\s]+/g, ' ').trim();

/** A name Tally will take: one clean line, at most 75 characters, never empty. */
export function ledgerName(raw: string, fallback = 'Ledger'): string {
  const clean = truncateText(singleLine(raw), LEDGER_NAME_MAX);
  return clean === '' ? fallback : clean;
}

/** A narration: one clean line, capped. */
export const narrationText = (raw: string): string => truncateText(singleLine(raw), NARRATION_MAX);

/**
 * Gives every name a unique place under Tally's folding rules. A second "Ram-Sons" after "Ram Sons"
 * becomes "Ram-Sons (2)"; truncation never produces a clash either. `reserved` are names Tally already owns.
 */
export class NameRegistry {
  private used = new Set<string>();
  constructor(reserved: readonly string[] = []) {
    for (const r of reserved) this.used.add(foldName(r));
  }

  assign(raw: string, fallback?: string): string {
    const base = ledgerName(raw, fallback);
    let candidate = base;
    for (let n = 2; this.used.has(foldName(candidate)); n += 1) {
      const suffix = ` (${n})`;
      candidate = `${truncateText(base, LEDGER_NAME_MAX - suffix.length)}${suffix}`;
    }
    this.used.add(foldName(candidate));
    return candidate;
  }
}

/** Tally amount: plain decimal, two places, debit negative, credit positive. `scaled` is a positive amount in paise. */
export function tallyAmount(side: 'debit' | 'credit', scaled: bigint): string {
  if (scaled <= 0n) throw new Error('tally: a voucher line must have a positive amount');
  const text = fromScaled(scaled, 2);
  return side === 'debit' ? `-${text}` : text;
}

/** 2026-04-01 -> 20260401 */
export function tallyDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`tally: not an ISO date: ${iso}`);
  return iso.replace(/-/g, '');
}

/** The file as bytes: UTF-16 little-endian with a byte-order mark, as the research recommends for Telugu names. */
export const encodeUtf16 = (text: string, bom = false): Buffer => Buffer.from(bom ? `﻿${text}` : text, 'utf16le');

/** The day before an ISO date. */
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
