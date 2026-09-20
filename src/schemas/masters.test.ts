import { describe, expect, it } from 'vitest';
import { gstinCheckChar } from '@/lib/gst';
import { createItemSchema } from './items';
import { organizationSchema } from './organization';
import { createPartySchema, partyAddressSchema } from './parties';

const gstin37 = (() => { const f = '37AAPFU0939F1Z'; return f + gstinCheckChar(f); })();
const gstin36 = (() => { const f = '36AAPFU0939F1Z'; return f + gstinCheckChar(f); })();
const msg = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues[0]?.message;

const party = { name: '  Ramesh Builders ', type: 'customer', stateCode: '37', gstin: '', phone: '', whatsappPhone: '', creditLimit: '', creditDays: '', interestRatePm: '' };

describe('createPartySchema', () => {
  it('accepts a minimal party and turns blanks into "not given"', () => {
    const r = createPartySchema.parse(party);
    expect(r.name).toBe('Ramesh Builders');
    expect(r.gstin).toBeUndefined();
    expect(r.creditLimit).toBeUndefined();
  });
  it('upper-cases a GSTIN and accepts one with a good check digit', () => {
    expect(createPartySchema.parse({ ...party, gstin: gstin37.toLowerCase() }).gstin).toBe(gstin37);
  });
  it('refuses a wrong check digit, with a message about the last character', () => {
    const bad = gstin37.slice(0, 14) + (gstin37[14] === 'A' ? 'B' : 'A');
    expect(msg(createPartySchema.safeParse({ ...party, gstin: bad }))).toBe('gstin_checksum');
  });
  it('refuses the wrong shape', () => {
    expect(msg(createPartySchema.safeParse({ ...party, gstin: '37AAPFU0939' }))).toBe('gstin_invalid');
  });
  it('refuses a GSTIN whose state is not the chosen state', () => {
    const r = createPartySchema.safeParse({ ...party, gstin: gstin36 });
    expect(r.success).toBe(false);
    expect(msg(r)).toBe('gstin_state');
  });
  it('refuses a made-up state code', () => {
    expect(msg(createPartySchema.safeParse({ ...party, stateCode: '00' }))).toBe('state_invalid');
    expect(msg(createPartySchema.safeParse({ ...party, stateCode: '28' }))).toBe('state_invalid');
  });
  it('cleans phone numbers and requires a real mobile for WhatsApp', () => {
    const r = createPartySchema.parse({ ...party, phone: '+91 98765-43210', whatsappPhone: '098765 43210' });
    expect(r.phone).toBe('9876543210');
    expect(r.whatsappPhone).toBe('9876543210');
    expect(msg(createPartySchema.safeParse({ ...party, whatsappPhone: '12345' }))).toBe('whatsapp_invalid');
    expect(msg(createPartySchema.safeParse({ ...party, phone: '12' }))).toBe('phone_invalid');
  });
  it('keeps money as a string and refuses more than 2 places or junk', () => {
    expect(createPartySchema.parse({ ...party, creditLimit: '250000.50' }).creditLimit).toBe('250000.50');
    expect(msg(createPartySchema.safeParse({ ...party, creditLimit: '1.234' }))).toBe('money_invalid');
    expect(msg(createPartySchema.safeParse({ ...party, creditLimit: '-5' }))).toBe('money_invalid');
    expect(msg(createPartySchema.safeParse({ ...party, creditLimit: '1e5' }))).toBe('money_invalid');
  });
  it('does not allow creating an employee here', () => {
    expect(msg(createPartySchema.safeParse({ ...party, type: 'employee' }))).toBe('type_invalid');
  });
  it('needs a name', () => {
    expect(msg(createPartySchema.safeParse({ ...party, name: '   ' }))).toBe('name_required');
  });
});

describe('partyAddressSchema', () => {
  const address = { partyId: '11111111-1111-4111-8111-111111111111', label: 'Site A', stateCode: '37', line1: '12-3 Main Road', city: 'Vijayawada', pincode: '520001' };
  it('accepts a full address', () => {
    expect(partyAddressSchema.safeParse(address).success).toBe(true);
  });
  it('needs a six-digit pincode not starting with 0', () => {
    expect(msg(partyAddressSchema.safeParse({ ...address, pincode: '52001' }))).toBe('pincode_invalid');
    expect(msg(partyAddressSchema.safeParse({ ...address, pincode: '020001' }))).toBe('pincode_invalid');
  });
});

const item = { name: 'Tiscon 12mm', brand: '', category: 'steel', hsnCode: '7214', gstRate: '18', baseUom: 'kg', altUom: '', conversionFactor: '', reorderLevel: '', saleRate: '58', isStock: true };

describe('createItemSchema', () => {
  it('accepts a plain item; reorder level defaults to 0', () => {
    const r = createItemSchema.parse(item);
    expect(r.reorderLevel).toBe('0');
    expect(r.altUom).toBeUndefined();
  });
  it('accepts a pieces-per-kg pair', () => {
    const r = createItemSchema.parse({ ...item, altUom: 'pc', conversionFactor: '10.660' });
    expect(r.altUom).toBe('pc');
    expect(r.conversionFactor).toBe('10.660');
  });
  it('the second unit and its factor go together', () => {
    expect(msg(createItemSchema.safeParse({ ...item, altUom: 'pc' }))).toBe('factor_required');
    expect(msg(createItemSchema.safeParse({ ...item, conversionFactor: '10' }))).toBe('uom_required');
    expect(msg(createItemSchema.safeParse({ ...item, altUom: 'pc', conversionFactor: '0' }))).toBe('factor_required');
    expect(msg(createItemSchema.safeParse({ ...item, altUom: 'KG', conversionFactor: '1' }))).toBe('uom_same');
  });
  it('HSN is 4-8 digits; GST rate 0-100; rates are decimal strings', () => {
    expect(msg(createItemSchema.safeParse({ ...item, hsnCode: '72' }))).toBe('hsn_invalid');
    expect(msg(createItemSchema.safeParse({ ...item, gstRate: '101' }))).toBe('rate_range');
    expect(msg(createItemSchema.safeParse({ ...item, saleRate: '58.00001' }))).toBe('number_invalid');
    expect(msg(createItemSchema.safeParse({ ...item, saleRate: '' }))).toBe('number_invalid');
  });
});

const org = { legalName: 'Daksha Nirmaan Traders', tradeName: '', gstin: '', stateCode: '37', address: { line1: 'D.No 12-3-45, Main Road', line2: '', city: 'Vijayawada', district: '', pincode: '521137' }, fyStartMonth: '4', invoiceBankDetails: '', upiVpa: '', invoiceFooter: '', einvoiceEnabled: false, allowNegativeStock: false };

describe('organizationSchema', () => {
  it('accepts the basics', () => {
    expect(organizationSchema.safeParse(org).success).toBe(true);
  });
  it('UPI ID must look like name@bank', () => {
    expect(organizationSchema.parse({ ...org, upiVpa: 'dakshanirmaan@sbi' }).upiVpa).toBe('dakshanirmaan@sbi');
    expect(msg(organizationSchema.safeParse({ ...org, upiVpa: 'not a vpa' }))).toBe('upi_invalid');
  });
  it('GSTIN must agree with the state', () => {
    expect(msg(organizationSchema.safeParse({ ...org, gstin: gstin36 }))).toBe('gstin_state');
    expect(organizationSchema.safeParse({ ...org, gstin: gstin37 }).success).toBe(true);
  });
  it('financial-year start is a month number', () => {
    expect(msg(organizationSchema.safeParse({ ...org, fyStartMonth: '13' }))).toBe('month_invalid');
  });
});

describe('credit and interest terms', () => {
  it('"no credit limit" travels as its own flag, separate from the typed limit', () => {
    const r = createPartySchema.parse({ ...party, creditUnlimited: true });
    expect(r.creditUnlimited).toBe(true);
    expect(r.creditLimit).toBeUndefined();
    expect(createPartySchema.parse(party).creditUnlimited).toBeUndefined();
  });
  it('interest is at most 999.99 a month (NUMERIC(5,2))', () => {
    expect(createPartySchema.parse({ ...party, interestRatePm: '999.99' }).interestRatePm).toBe('999.99');
    expect(msg(createPartySchema.safeParse({ ...party, interestRatePm: '1000' }))).toBe('interest_range');
    expect(msg(createPartySchema.safeParse({ ...party, interestRatePm: '1.234' }))).toBe('money_invalid');
  });
  it('a credit limit must fit NUMERIC(14,2): 12 digits before the point', () => {
    expect(createPartySchema.parse({ ...party, creditLimit: '999999999999.99' }).creditLimit).toBe('999999999999.99');
    expect(msg(createPartySchema.safeParse({ ...party, creditLimit: '1000000000000' }))).toBe('number_too_large');
  });
});

describe('item numbers fit their columns', () => {
  it('reorder level NUMERIC(12,3), conversion factor NUMERIC(12,4), sale rate NUMERIC(14,4)', () => {
    expect(msg(createItemSchema.safeParse({ ...item, reorderLevel: '1000000000' }))).toBe('number_too_large');
    expect(createItemSchema.safeParse({ ...item, reorderLevel: '999999999.999' }).success).toBe(true);
    expect(msg(createItemSchema.safeParse({ ...item, altUom: 'pc', conversionFactor: '100000000' }))).toBe('number_too_large');
    expect(msg(createItemSchema.safeParse({ ...item, saleRate: '10000000000' }))).toBe('number_too_large');
    expect(createItemSchema.safeParse({ ...item, saleRate: '9999999999.9999' }).success).toBe(true);
  });
});
