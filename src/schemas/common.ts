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

export const optionalText = (max: number, message = 'text_long') =>
  z.preprocess(blankToUndefined, z.string().trim().max(max, message).optional());

export const stateField = z.string().refine(isStateCode, 'state_invalid');

export const addressSchema = z.object({
  line1: z.string().trim().min(1, 'address_required').max(120, 'text_long'),
  line2: optionalText(120),
  city: z.string().trim().min(1, 'city_required').max(60, 'text_long'),
  district: optionalText(60),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'pincode_invalid'),
});
export type AddressInput = z.infer<typeof addressSchema>;
