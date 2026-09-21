import { describe, expect, it } from 'vitest';
import { isMobile, isPhone, normalisePhone, whatsappNumber } from './phone';

describe('normalisePhone', () => {
  it('strips spaces, dashes, brackets, +91 and a leading 0', () => {
    expect(normalisePhone('98765 43210')).toBe('9876543210');
    expect(normalisePhone('+91 98765-43210')).toBe('9876543210');
    expect(normalisePhone('098765 43210')).toBe('9876543210');
    expect(normalisePhone('(0866) 2456789')).toBe('8662456789');
  });
  it('leaves other lengths alone (the schema decides if they are valid)', () => {
    expect(normalisePhone('12345')).toBe('12345');
    expect(normalisePhone('')).toBe('');
  });
});

describe('isMobile / isPhone', () => {
  it('a mobile is ten digits starting 6-9', () => {
    expect(isMobile('9876543210')).toBe(true);
    expect(isMobile('5876543210')).toBe(false);
    expect(isMobile('987654321')).toBe(false);
  });
  it('a phone is 6-13 digits (landlines allowed)', () => {
    expect(isPhone('8662456789')).toBe(true);
    expect(isPhone('12345')).toBe(false);
    expect(isPhone('98x6543210')).toBe(false);
  });
});

describe('whatsappNumber', () => {
  it('accepts a plain or +91 mobile', () => {
    expect(whatsappNumber('98765 43210')).toBe('9876543210');
    expect(whatsappNumber('+91 98765-43210')).toBe('9876543210');
    expect(whatsappNumber('919876543210')).toBe('9876543210');
  });
  it('refuses anything a landline could be, and anything malformed', () => {
    expect(whatsappNumber('0863 2345678')).toBeNull();
    expect(whatsappNumber('098765 43210')).toBeNull();
    expect(whatsappNumber('58765 43210')).toBeNull();
    expect(whatsappNumber('')).toBeNull();
    expect(whatsappNumber(null)).toBeNull();
  });
});
