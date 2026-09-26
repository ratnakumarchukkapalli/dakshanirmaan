import { describe, expect, it } from 'vitest';
import { closeBlock, monthStart, moneyGap, pageCount, parseCloseDate, parsePage, parseRange, sameMoney, validIso } from './reports-math';

describe('validIso', () => {
  it('accepts real dates only', () => {
    expect(validIso('2026-09-26')).toBe('2026-09-26');
    for (const bad of ['2026-02-30', '2026-13-01', '26-09-2026', '2026-9-26', '', undefined, null, '2026-09-26T00:00']) expect(validIso(bad as string)).toBeNull();
  });
});

describe('parseRange', () => {
  const today = '2026-09-26';
  it('defaults to this month so far', () => {
    expect(parseRange(undefined, undefined, today)).toEqual({ from: '2026-09-01', to: '2026-09-26' });
    expect(monthStart('2026-09-26')).toBe('2026-09-01');
  });
  it('falls back per side when a date is not real', () => {
    expect(parseRange('nonsense', '2026-09-10', today)).toEqual({ from: '2026-09-01', to: '2026-09-10' });
    expect(parseRange('2026-08-15', '2026-02-30', today)).toEqual({ from: '2026-08-15', to: '2026-09-26' });
  });
  it('swaps a reversed range instead of showing nothing', () => {
    expect(parseRange('2026-09-20', '2026-09-05', today)).toEqual({ from: '2026-09-05', to: '2026-09-20' });
  });
});

describe('parseCloseDate', () => {
  it('is today unless a real date not after today is given', () => {
    expect(parseCloseDate(undefined, '2026-09-26')).toBe('2026-09-26');
    expect(parseCloseDate('2026-09-20', '2026-09-26')).toBe('2026-09-20');
    expect(parseCloseDate('2026-09-27', '2026-09-26')).toBe('2026-09-26');
    expect(parseCloseDate('garbage', '2026-09-26')).toBe('2026-09-26');
  });
});

describe('paging', () => {
  it('counts pages, at least one', () => {
    expect(pageCount(0, 100)).toBe(1);
    expect(pageCount(100, 100)).toBe(1);
    expect(pageCount(101, 100)).toBe(2);
  });
  it('clamps the requested page', () => {
    expect(parsePage(undefined, 5)).toBe(1);
    expect(parsePage('0', 5)).toBe(1);
    expect(parsePage('-3', 5)).toBe(1);
    expect(parsePage('abc', 5)).toBe(1);
    expect(parsePage('9', 5)).toBe(5);
    expect(parsePage('3', 5)).toBe(3);
  });
});

describe('reconciliation helpers', () => {
  it('compares and differences money exactly', () => {
    expect(sameMoney('0.10', '0.1')).toBe(true);
    expect(sameMoney('100.00', '100.01')).toBe(false);
    expect(moneyGap('100.10', '100.00')).toBe('0.10');
    expect(moneyGap('50.00', '75.25')).toBe('-25.25');
  });
});

describe('closeBlock', () => {
  const today = '2026-09-26';
  it('a later live close blocks an earlier day for everyone', () => {
    expect(closeBlock({ date: '2026-09-20', today, latestClose: '2026-09-25', isAdmin: false })).toBe('later_close');
    expect(closeBlock({ date: '2026-09-20', today, latestClose: '2026-09-25', isAdmin: true })).toBe('later_close');
  });
  it('the latest close itself, or nothing closed, does not block', () => {
    expect(closeBlock({ date: '2026-09-25', today, latestClose: '2026-09-25', isAdmin: true })).toBeNull();
    expect(closeBlock({ date: '2026-09-26', today, latestClose: null, isAdmin: false })).toBeNull();
  });
  it('a counter may close today or yesterday only; an owner may close any past day', () => {
    expect(closeBlock({ date: '2026-09-26', today, latestClose: null, isAdmin: false })).toBeNull();
    expect(closeBlock({ date: '2026-09-25', today, latestClose: null, isAdmin: false })).toBeNull();
    expect(closeBlock({ date: '2026-09-24', today, latestClose: null, isAdmin: false })).toBe('too_old');
    expect(closeBlock({ date: '2026-09-24', today, latestClose: null, isAdmin: true })).toBeNull();
  });
});
