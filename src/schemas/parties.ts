import { z } from 'zod';
import { isMobile, isPhone, normalisePhone } from '@/lib/phone';
import { addressSchema, blankToUndefined, boundedDecimal, decimal, stateField } from './common';
import { gstinField, gstinMatchesState } from './gstin';

const phoneField = z.preprocess(
  (v) => blankToUndefined(typeof v === 'string' ? normalisePhone(v) : v),
  z.string().refine(isPhone, 'phone_invalid').optional(),
);
const whatsappField = z.preprocess(
  (v) => blankToUndefined(typeof v === 'string' ? normalisePhone(v) : v),
  z.string().refine(isMobile, 'whatsapp_invalid').optional(),
);

/**
 * Credit terms: owners only (the database also refuses a counter user). Blank = not given.
 * `creditUnlimited` = "no credit limit" (stored as NULL, which the database reads as unlimited;
 * 0 means no credit at all). It wins over any typed limit.
 */
const termsShape = {
  creditLimit: z.preprocess(blankToUndefined, boundedDecimal(14, 2, 'money_invalid').optional()),
  creditUnlimited: z.boolean().optional(),
  creditDays: z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{1,4}$/, 'days_invalid').optional()),
  // NUMERIC(5,2): at most 999.99 a month.
  interestRatePm: z.preprocess(
    blankToUndefined,
    decimal(2, 'money_invalid').refine((v) => Number(v) <= 999.99, 'interest_range').optional(),
  ),
};

const partyShape = {
  name: z.string().trim().min(1, 'name_required').max(120, 'text_long'),
  // Employees are created from the staff screen, not here.
  type: z.enum(['customer', 'supplier', 'both'], 'type_invalid'),
  gstin: gstinField,
  stateCode: stateField,
  phone: phoneField,
  whatsappPhone: whatsappField,
  ...termsShape,
};

const checkGstinState = (v: { gstin?: string; stateCode: string }, ctx: z.RefinementCtx) => {
  if (!gstinMatchesState(v.gstin, v.stateCode)) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'gstin_state' });
};

/**
 * On an existing party an owner who unticks "No credit limit" must give a limit (0 = no credit):
 * otherwise nothing would be sent and the party would silently stay unlimited. A counter user
 * sends no credit fields at all (`creditUnlimited` undefined), so this never touches them.
 */
const checkLimitGiven = (v: { creditUnlimited?: boolean; creditLimit?: string }, ctx: z.RefinementCtx) => {
  if (v.creditUnlimited === false && v.creditLimit === undefined) {
    ctx.addIssue({ code: 'custom', path: ['creditLimit'], message: 'credit_limit_required' });
  }
};

export const createPartySchema = z.object(partyShape).superRefine(checkGstinState);
export const updatePartySchema = z
  .object({ id: z.uuid('id_invalid'), ...partyShape })
  .superRefine((v, ctx) => {
    checkGstinState(v, ctx);
    checkLimitGiven(v, ctx);
  });

/**
 * What a counter user may change on an existing party. Type, GSTIN, state and credit terms are
 * owner-only, so they are not validated here: a legacy party whose stored GSTIN or state would
 * fail today's stricter checks can still have its name and phones corrected.
 */
const basicsShape = { name: partyShape.name, phone: partyShape.phone, whatsappPhone: partyShape.whatsappPhone };
export const partyBasicsSchema = z.object(basicsShape);
export const updatePartyBasicsSchema = z.object({ id: z.uuid('id_invalid'), ...basicsShape });

export const partyAddressSchema = z.object({
  partyId: z.uuid('id_invalid'),
  label: z.string().trim().min(1, 'label_required').max(40, 'text_long'),
  stateCode: stateField,
  ...addressSchema.shape,
});

export const partyIdSchema = z.object({ partyId: z.uuid('id_invalid') });
export const defaultSiteSchema = z.object({ partyId: z.uuid('id_invalid'), addressId: z.uuid('id_invalid') });

export type CreatePartyInput = z.input<typeof createPartySchema>;
export type CreatePartyOutput = z.output<typeof createPartySchema>;
