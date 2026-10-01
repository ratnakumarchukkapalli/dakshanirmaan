import { describe, expect, it } from 'vitest';
import { derivePlaceOfSupply } from './place-of-supply';

const sites = [
  { id: 'bill', stateCode: '37', isBilling: true },
  { id: 'hyd', stateCode: '36', isBilling: false },
];

describe('derivePlaceOfSupply', () => {
  it('uses the chosen delivery site', () => expect(derivePlaceOfSupply(sites, 'hyd', '37')).toBe('36'));
  it('uses the default (billing) address when no site is chosen, even when the customer\'s own state differs', () => {
    expect(derivePlaceOfSupply(sites, '', '36')).toBe('37');
    expect(derivePlaceOfSupply(sites, undefined, '36')).toBe('37');
  });
  it('chosen billing site is the same as none chosen', () => expect(derivePlaceOfSupply(sites, 'bill', '36')).toBe('37'));
  it('falls back to the customer\'s state when there is no address, and to nothing when there is no customer', () => {
    expect(derivePlaceOfSupply([], '', '36')).toBe('36');
    expect(derivePlaceOfSupply([], '', undefined)).toBeNull();
  });
  it('a site that is not the customer\'s own is ignored (the server refuses it separately)', () => {
    expect(derivePlaceOfSupply(sites, 'someone-elses', '37')).toBe('37');
  });
});
