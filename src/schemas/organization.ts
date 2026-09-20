import { z } from 'zod';
import { addressSchema, optionalText, stateField } from './common';
import { gstinField, gstinMatchesState } from './gstin';

export const organizationSchema = z
  .object({
    legalName: z.string().trim().min(1, 'name_required').max(120, 'text_long'),
    tradeName: optionalText(120),
    gstin: gstinField,
    stateCode: stateField,
    address: addressSchema,
    fyStartMonth: z.string().regex(/^(1[0-2]|[1-9])$/, 'month_invalid'),
    invoiceBankDetails: optionalText(200),
    upiVpa: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._-]{2,255}@[A-Za-z][A-Za-z0-9]{1,63}$/, 'upi_invalid')
        .optional(),
    ),
    invoiceFooter: optionalText(200),
    einvoiceEnabled: z.boolean(),
    allowNegativeStock: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (!gstinMatchesState(v.gstin, v.stateCode)) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'gstin_state' });
  });

export type OrganizationFormInput = z.input<typeof organizationSchema>;
export type OrganizationFormOutput = z.output<typeof organizationSchema>;
