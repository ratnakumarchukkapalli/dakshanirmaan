/**
 * Keeps digits only and drops an Indian country code / trunk zero:
 * "+91 98765-43210" and "098765 43210" both become "9876543210".
 */
export function normalisePhone(input: string): string {
  let digits = input.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

export const isMobile = (digits: string): boolean => /^[6-9][0-9]{9}$/.test(digits);
export const isPhone = (digits: string): boolean => /^[0-9]{6,13}$/.test(digits);
