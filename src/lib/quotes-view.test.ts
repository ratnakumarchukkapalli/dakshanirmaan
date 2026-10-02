import { describe, expect, it } from 'vitest';
import { addDaysIso, expiresWithin, isQuoteStatus, quoteActions } from './quotes-view';

describe('quoteActions', () => {
  it('an open, in-date quote can be edited, accepted, expired and converted', () => {
    expect(quoteActions('open', 'open')).toEqual({ edit: true, accept: true, reopen: false, expire: true, convert: true });
  });
  it('an accepted, in-date quote can be reopened, expired and converted, not edited', () => {
    expect(quoteActions('accepted', 'accepted')).toEqual({ edit: false, accept: false, reopen: true, expire: true, convert: true });
  });
  it('an open quote past its date can be edited (to extend it) or expired, nothing else', () => {
    expect(quoteActions('open', 'expired')).toEqual({ edit: true, accept: false, reopen: false, expire: true, convert: false });
  });
  it('an accepted quote past its date can be reopened (to extend it) or expired, not converted', () => {
    expect(quoteActions('accepted', 'expired')).toEqual({ edit: false, accept: false, reopen: true, expire: true, convert: false });
  });
  it('expired and converted quotes offer nothing', () => {
    const none = { edit: false, accept: false, reopen: false, expire: false, convert: false };
    expect(quoteActions('expired', 'expired')).toEqual(none);
    expect(quoteActions('converted', 'converted')).toEqual(none);
  });
});

describe('dates', () => {
  it('adds calendar days across month and year ends', () => {
    expect(addDaysIso('2026-10-30', 2)).toBe('2026-11-01');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29');
  });
  it('expiring soon: today through two days out, open or accepted only', () => {
    expect(expiresWithin('open', '2026-10-02', '2026-10-02')).toBe(true);
    expect(expiresWithin('accepted', '2026-10-04', '2026-10-02')).toBe(true);
    expect(expiresWithin('open', '2026-10-05', '2026-10-02')).toBe(false);
    expect(expiresWithin('open', '2026-10-01', '2026-10-02')).toBe(false);
    expect(expiresWithin('expired', '2026-10-03', '2026-10-02')).toBe(false);
    expect(expiresWithin('converted', '2026-10-03', '2026-10-02')).toBe(false);
  });
  it('knows its statuses', () => {
    expect(isQuoteStatus('open')).toBe(true);
    expect(isQuoteStatus('draft')).toBe(false);
    expect(isQuoteStatus(null)).toBe(false);
  });
});
