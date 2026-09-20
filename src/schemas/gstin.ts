import { z } from 'zod';
import { GSTIN_PATTERN, gstinChecksumOk } from '@/lib/gst';
import { blankToUndefined } from './common';

/** Optional GSTIN: upper-cased, right shape, right check digit. State agreement is checked by the form schema. */
export const gstinField = z.preprocess(
  (v) => blankToUndefined(typeof v === 'string' ? v.trim().toUpperCase() : v),
  z
    .string()
    .refine((v) => GSTIN_PATTERN.test(v), 'gstin_invalid')
    .refine((v) => !GSTIN_PATTERN.test(v) || gstinChecksumOk(v), 'gstin_checksum')
    .optional(),
);

/** The first two digits of a GSTIN are its state; they must be the state on the record. */
export function gstinMatchesState(gstin: string | undefined, stateCode: string): boolean {
  return gstin === undefined || gstin.slice(0, 2) === stateCode;
}
