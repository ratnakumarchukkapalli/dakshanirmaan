import { describe, expect, it } from 'vitest';
import { recordAdjustmentSchema, recordTransferSchema } from './stock';
import { advanceSchema, createEmployeeSchema, salarySchema, wagesSchema } from './staff';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

// Every schema here runs twice: in the form (zodResolver) and again in the server action. The
// output of the first run must be accepted by the second (a `.transform` that changes the shape
// once shipped as "Choose a month" on a valid salary form).
function idempotent<T>(schema: { parse: (v: unknown) => T; safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
  const once = schema.parse(input);
  expect(schema.safeParse(once).success).toBe(true);
}

describe('stock and staff schemas survive being parsed twice', () => {
  it('adjustment and transfer', () => {
    idempotent(recordAdjustmentSchema, { id: ID, adjDate: '2026-09-20', warehouseId: ID, reason: 'torn', lines: [{ itemId: ID2, direction: 'found', qty: '3.5', rate: '' }] });
    idempotent(recordTransferSchema, { id: ID, transferDate: '2026-09-20', fromWarehouseId: ID, toWarehouseId: ID2, vehicleNo: '', lines: [{ itemId: ID, qty: '10' }] });
  });
  it('staff vouchers and employee', () => {
    const base = { id: ID, voucherDate: '2026-09-20', payAccountId: ID };
    idempotent(advanceSchema, { ...base, employeeId: ID2, amount: '2000', note: '' });
    idempotent(salarySchema, { ...base, employeeId: ID2, month: '2026-08', amount: '18000', advanceRecovered: '' });
    idempotent(wagesSchema, { ...base, employeeId: '', days: '5.5', rate: '600', advanceRecovered: '', note: '' });
    idempotent(createEmployeeSchema, { name: 'A', phone: '98765 43210', monthlySalary: '', dailyWage: '600' });
  });
});

describe('stock and staff schemas refuse what the database would', () => {
  it('a rate on a loss, a zero or over-precise quantity, the same godown twice', () => {
    const line = { itemId: ID, direction: 'loss' as const, qty: '1', rate: '' };
    const adj = { id: ID, adjDate: '2026-09-20', warehouseId: ID, reason: 'torn' };
    expect(recordAdjustmentSchema.safeParse({ ...adj, lines: [{ ...line, rate: '5' }] }).success).toBe(false);
    expect(recordAdjustmentSchema.safeParse({ ...adj, lines: [{ ...line, qty: '0' }] }).success).toBe(false);
    expect(recordAdjustmentSchema.safeParse({ ...adj, lines: [{ ...line, qty: '1.2345' }] }).success).toBe(false);
    expect(recordAdjustmentSchema.safeParse({ ...adj, reason: 'x', lines: [line] }).success).toBe(false);
    expect(recordTransferSchema.safeParse({ id: ID, transferDate: '2026-09-20', fromWarehouseId: ID, toWarehouseId: ID, lines: [{ itemId: ID, qty: '1' }] }).success).toBe(false);
  });
  it('a zero advance, a bad month, days with two decimals', () => {
    const base = { id: ID, voucherDate: '2026-09-20', payAccountId: ID };
    expect(advanceSchema.safeParse({ ...base, employeeId: ID2, amount: '0' }).success).toBe(false);
    expect(salarySchema.safeParse({ ...base, employeeId: ID2, month: '2026-13', amount: '1' }).success).toBe(false);
    expect(wagesSchema.safeParse({ ...base, days: '1.25', rate: '600' }).success).toBe(false);
  });
  it('every posting request carries a client-generated id, and a non-uuid is refused', () => {
    const base = { voucherDate: '2026-09-20', payAccountId: ID, employeeId: ID2, amount: '5' };
    expect(advanceSchema.safeParse(base).success).toBe(false);
    expect(advanceSchema.safeParse({ ...base, id: 'not-a-uuid' }).success).toBe(false);
    expect(advanceSchema.safeParse({ ...base, id: ID }).success).toBe(true);
    expect(recordTransferSchema.safeParse({ transferDate: '2026-09-20', fromWarehouseId: ID, toWarehouseId: ID2, lines: [{ itemId: ID, qty: '1' }] }).success).toBe(false);
  });
});
