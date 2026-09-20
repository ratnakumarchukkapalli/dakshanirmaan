// GST helpers: state codes and GSTIN validation. Pure, so forms, actions and tests share them.

/** Current GST state / UT codes (25 and 28 are retired and deliberately absent). */
export const GST_STATES: readonly { code: string; name: string }[] = [
  { code: '01', name: 'Jammu and Kashmir' }, { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' }, { code: '04', name: 'Chandigarh' }, { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' }, { code: '07', name: 'Delhi' }, { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' }, { code: '10', name: 'Bihar' }, { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' }, { code: '13', name: 'Nagaland' }, { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' }, { code: '16', name: 'Tripura' }, { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' }, { code: '19', name: 'West Bengal' }, { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' }, { code: '22', name: 'Chhattisgarh' }, { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' }, { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' }, { code: '29', name: 'Karnataka' }, { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' }, { code: '32', name: 'Kerala' }, { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' }, { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' }, { code: '37', name: 'Andhra Pradesh' }, { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other Territory' }, { code: '99', name: 'Centre Jurisdiction' },
];

const STATE_CODES = new Set(GST_STATES.map((s) => s.code));
export const isStateCode = (code: string): boolean => STATE_CODES.has(code);
export const stateName = (code: string): string => GST_STATES.find((s) => s.code === code)?.name ?? code;

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The 15th GSTIN character, computed from the first 14 (the portal's mod-36 check digit). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = ALPHABET.indexOf(first14[i] ?? '');
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36]!;
}

export const gstinChecksumOk = (gstin: string): boolean =>
  GSTIN_PATTERN.test(gstin) && gstinCheckChar(gstin.slice(0, 14)) === gstin[14];

export const stateOfGstin = (gstin: string): string | null => {
  const code = gstin.slice(0, 2);
  return isStateCode(code) ? code : null;
};

/** Goods worth more than this (rupees) moved by road usually need an e-way bill. A hint threshold only; the portal is the authority. */
export const EWAY_BILL_THRESHOLD = '50000';
