import { z } from 'zod';
import { isStateCode } from '@/lib/gst';

// Messages are i18n keys under `errors.field.*`; forms translate them.

/** Empty text box → undefined (so "not filled in" and "left blank" mean the same). */
export const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** A decimal that travels as a string (never a float) with at most `dp` places. */
export const decimal = (dp: number, message = 'number_invalid') =>
  z.string().trim().regex(new RegExp(`^\\d+(\\.\\d{1,${dp}})?$`), message);

/**
 * Same, but also bounded to what a NUMERIC(precision, dp) column can hold: at most
 * `precision - dp` digits before the point. Stops "number too large" reaching the database.
 */
export const boundedDecimal = (precision: number, dp: number, message = 'number_invalid') =>
  decimal(dp, message).regex(new RegExp(`^\\d{1,${precision - dp}}(\\.|$)`), 'number_too_large');

/**
 * Control characters (a stray ^A from a paste, an escape sequence, a NUL) break Excel files and print as junk, so
 * names, narrations and notes refuse them. A free-text NOTE may also hold tab and new lines.
 */
export const noControlChars = (v: string) => !/\p{Cc}/u.test(v);
export const noControlCharsExceptBreaks = (v: string) => !/[^\P{Cc}\t\n]/u.test(v);

export const optionalText = (max: number, message = 'text_long', multiline = false) =>
  z.preprocess(
    blankToUndefined,
    z.string().trim().max(max, message).refine(multiline ? noControlCharsExceptBreaks : noControlChars, 'text_invalid').optional(),
  );

export const stateField = z.string().refine(isStateCode, 'state_invalid');

export const addressSchema = z.object({
  line1: z.string().trim().min(1, 'address_required').max(120, 'text_long').refine(noControlChars, 'text_invalid'),
  line2: optionalText(120),
  city: z.string().trim().min(1, 'city_required').max(60, 'text_long').refine(noControlChars, 'text_invalid'),
  district: optionalText(60),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'pincode_invalid'),
});
export type AddressInput = z.infer<typeof addressSchema>;

/** A real calendar date on the wire (YYYY-MM-DD). Forms hold ISO and show DD-MM-YYYY. */
export const isoDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date_invalid')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, 'date_invalid');

/** Quantity NUMERIC(12,3), more than zero (text, never a float). */
export const positiveQty = boundedDecimal(12, 3, 'qty_invalid').refine((v) => /[1-9]/.test(v), 'qty_positive');
