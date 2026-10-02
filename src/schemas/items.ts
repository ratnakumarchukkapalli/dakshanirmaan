import { z } from 'zod';
import { blankToUndefined, boundedDecimal, decimal, noControlChars, optionalText } from './common';

const itemShape = {
  name: z.string().trim().min(1, 'name_required').max(120, 'text_long').refine(noControlChars, 'text_invalid'),
  brand: optionalText(60),
  category: z.enum(['cement', 'steel', 'other'], 'category_invalid'),
  hsnCode: z.string().trim().regex(/^[0-9]{4,8}$/, 'hsn_invalid'),
  gstRate: decimal(2, 'number_invalid').refine((v) => Number(v) <= 100, 'rate_range'),
  baseUom: z.string().trim().min(1, 'uom_required').max(20, 'text_long'),
  altUom: optionalText(20),
  conversionFactor: z.preprocess(blankToUndefined, boundedDecimal(12, 4, 'number_invalid').optional()),
  reorderLevel: z.preprocess(blankToUndefined, boundedDecimal(12, 3, 'number_invalid').default('0')),
  saleRate: boundedDecimal(14, 4, 'number_invalid'),
  isStock: z.boolean(),
};

/** A second unit (pieces for a kg-based steel bar) needs a positive factor and a different name. */
function checkUnits(v: { baseUom: string; altUom?: string; conversionFactor?: string }, ctx: z.RefinementCtx) {
  if (v.altUom === undefined && v.conversionFactor === undefined) return;
  if (v.altUom === undefined) ctx.addIssue({ code: 'custom', path: ['altUom'], message: 'uom_required' });
  else if (v.conversionFactor === undefined || !(Number(v.conversionFactor) > 0))
    ctx.addIssue({ code: 'custom', path: ['conversionFactor'], message: 'factor_required' });
  else if (v.altUom.toLowerCase() === v.baseUom.toLowerCase())
    ctx.addIssue({ code: 'custom', path: ['altUom'], message: 'uom_same' });
}

export const createItemSchema = z.object(itemShape).superRefine(checkUnits);
export const updateItemSchema = z.object({ id: z.uuid('id_invalid'), ...itemShape }).superRefine(checkUnits);
export const itemIdSchema = z.object({ itemId: z.uuid('id_invalid') });

export type ItemFormInput = z.input<typeof createItemSchema>;
export type ItemFormOutput = z.output<typeof createItemSchema>;
