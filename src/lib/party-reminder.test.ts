import { describe, expect, it } from 'vitest';
import { reminderUrl } from './party-reminder';

describe('reminderUrl', () => {
  it('builds a wa.me link with the message encoded', () => {
    expect(reminderUrl('98765 43210', 'Dues: Rs 5,000 & more')).toBe(
      `https://wa.me/919876543210?text=${encodeURIComponent('Dues: Rs 5,000 & more')}`,
    );
  });
  it('refuses a landline or a missing number', () => {
    expect(reminderUrl('0863 2345678', 'x')).toBeNull();
    expect(reminderUrl(null, 'x')).toBeNull();
  });
});
