import { describe, expect, it } from 'vitest';
import { isUuid } from './uuid';

describe('isUuid', () => {
  it('accepts a real uuid in either case', () => {
    expect(isUuid('3f2b1c1e-0000-4000-8000-000000000000')).toBe(true);
    expect(isUuid('3F2B1C1E-0000-4000-8000-000000000000')).toBe(true);
  });
  it('refuses look-alikes that Postgres would reject', () => {
    expect(isUuid('-'.repeat(36))).toBe(false);
    expect(isUuid('3f2b1c1e-0000-4000-8000-00000000000')).toBe(false);
    expect(isUuid('3f2b1c1e-0000-4000-8000-0000000000000')).toBe(false);
    expect(isUuid('3f2b1c1e-0000-4000-8000-00000000000g')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
