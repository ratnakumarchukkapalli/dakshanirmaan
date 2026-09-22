import { z } from 'zod';
import { blankToUndefined } from './common';
import { invoiceLineSchema, MAX_INVOICE_LINES } from './sales';

// Delivery challan input, shared by the challan form and the server actions. Same money/quantity
// discipline as sales.ts: everything travels as a string, never a float. Lines reuse
// `invoiceLineSchema` — a challan line is the same snapshot shape as an invoice line minus tax
// amounts (db-architecture: delivery_challan_lines).

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date_invalid')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, 'date_invalid');

export const saveDraftChallanSchema = z
  .object({
    /** Present = update this draft; absent = create one. */
    id: z.preprocess(blankToUndefined, z.uuid('id_invalid').optional()),
    /** The `updated_at` the form loaded; a different one in the database means someone else saved first. */
    expectedUpdatedAt: z.preprocess(blankToUndefined, z.string().max(40).optional()),
    partyId: z.uuid('party_required'),
    challanDate: isoDate,
    /** A delivery site (one of the party's addresses); blank = the party's registered address. */
    siteId: z.preprocess(blankToUndefined, z.uuid('id_invalid').optional()),
    vehicleNo: z.preprocess(
      blankToUndefined,
      z.string().trim().transform((v) => v.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9 -]{4,20}$/, 'vehicle_invalid')).optional(),
    ),
    lines: z.array(invoiceLineSchema).min(1, 'lines_required').max(MAX_INVOICE_LINES, 'lines_many'),
  })
  .superRefine((v, ctx) => {
    if (v.id && !v.expectedUpdatedAt) ctx.addIssue({ code: 'custom', path: ['expectedUpdatedAt'], message: 'stale_version_missing' });
  });

export const challanIdSchema = z.object({ id: z.uuid('id_invalid') });

export type SaveDraftChallanInput = z.input<typeof saveDraftChallanSchema>;
export type SaveDraftChallanOutput = z.output<typeof saveDraftChallanSchema>;
