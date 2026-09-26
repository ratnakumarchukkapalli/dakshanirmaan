import { z } from 'zod';
import { blankToUndefined, boundedDecimal, isoDateField, positiveQty } from './common';

// Godown adjustment and transfer input, shared by the modals and the server actions. Quantities
// are text in the item's base unit (3 dp). Messages are `errors.field.*` keys. The database is the
// authority on stock levels, costing and who may post (`post_stock_adjustment` / `post_stock_transfer`
// are admin-only).

export const MAX_STOCK_LINES = 50;

export const adjustmentLineSchema = z
  .object({
    itemId: z.uuid('item_required'),
    /** loss = shrinkage/damage (stock out, valued at the current average); found = stock in. */
    direction: z.enum(['loss', 'found'], 'direction_invalid'),
    qty: positiveQty,
    /** Found stock only: what it is worth per base unit. Blank = the current average (the database refuses a zero valuation). */
    rate: z.preprocess(blankToUndefined, boundedDecimal(14, 4, 'rate_invalid').optional()),
  })
  .superRefine((v, ctx) => {
    if (v.direction === 'loss' && v.rate !== undefined) ctx.addIssue({ code: 'custom', path: ['rate'], message: 'rate_on_loss' });
  });

/** Client-generated per modal open: the draft is inserted with it, so a retry cannot post a second document. */
const requestId = z.uuid('request_invalid');

export const recordAdjustmentSchema = z.object({
  id: requestId,
  adjDate: isoDateField,
  warehouseId: z.uuid('godown_required'),
  reason: z.string().trim().min(3, 'reason_required').max(200, 'text_long'),
  lines: z.array(adjustmentLineSchema).min(1, 'lines_required').max(MAX_STOCK_LINES, 'lines_many'),
});

export const transferLineSchema = z.object({ itemId: z.uuid('item_required'), qty: positiveQty });

export const recordTransferSchema = z
  .object({
    id: requestId,
    transferDate: isoDateField,
    fromWarehouseId: z.uuid('godown_required'),
    toWarehouseId: z.uuid('godown_required'),
    vehicleNo: z.preprocess(blankToUndefined, z.string().trim().min(4, 'vehicle_invalid').max(20, 'vehicle_invalid').regex(/^[A-Za-z0-9 -]+$/, 'vehicle_invalid').optional()),
    lines: z.array(transferLineSchema).min(1, 'lines_required').max(MAX_STOCK_LINES, 'lines_many'),
  })
  .superRefine((v, ctx) => {
    if (v.fromWarehouseId === v.toWarehouseId) ctx.addIssue({ code: 'custom', path: ['toWarehouseId'], message: 'godown_same' });
  });

export const transferIdSchema = z.object({ id: z.uuid('id_invalid') });

export type RecordAdjustmentInput = z.input<typeof recordAdjustmentSchema>;
export type RecordAdjustmentOutput = z.output<typeof recordAdjustmentSchema>;
export type RecordTransferInput = z.input<typeof recordTransferSchema>;
export type RecordTransferOutput = z.output<typeof recordTransferSchema>;
