import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Call } from '@/test/harness';
import { createAttachmentUpload, deleteAttachment, recordAttachment } from './attachments';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const BILL = '11111111-1111-4111-8111-111111111111';
const ROW = '44444444-4444-4444-8444-444444444444';
const PATH = `purchase_invoice/${BILL}/55555555-5555-4555-8555-555555555555.jpg`;
const forbidden = { ok: false, code: 'forbidden', error: 'forbidden' };

const jpeg = (size: number) => { const b = new Uint8Array(size); b.set([0xff, 0xd8, 0xff, 0xe0]); return new Blob([b], { type: 'image/jpeg' }); };
const html = (size: number) => new Blob([`<html>${'x'.repeat(size)}`.slice(0, size)], { type: 'image/jpeg' });
const request = { entity: 'purchase_invoice', entityId: BILL, mime: 'image/jpeg', bytes: 1000 };
const record = { ...request, path: PATH };

const find = (table: string, op: Call['op']) => state.calls.find((c) => c.table === table && c.op === op);
const removed = () => state.storageCalls.filter((c) => c.fn === 'remove');

function healthy(bill: { status: string } | null = { status: 'draft' }, count = 0) {
  state.respond = (c) => {
    if (c.table === 'purchase_invoices') return { data: bill ? [{ id: BILL, ...bill }] : [] };
    if (c.table === 'attachments' && c.op === 'select') return { data: [{ id: ROW, storage_path: PATH, entity_id: BILL }], count };
    if (c.table === 'attachments' && c.op === 'insert') return { data: [{ id: ROW }] };
    if (c.table === 'attachments' && c.op === 'delete') return { data: [{ id: ROW }] };
    return { data: null };
  };
  state.storage.createSignedUploadUrl = (path) => ({ data: { path, token: 'tok', signedUrl: 'u' }, error: null });
  state.storage.download = () => ({ data: jpeg(1000), error: null });
  state.storage.remove = () => ({ data: [{}], error: null });
}

describe('every attachment action is owner-only', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['createAttachmentUpload', () => createAttachmentUpload(request)],
    ['recordAttachment', () => recordAttachment(record)],
    ['deleteAttachment', () => deleteAttachment({ id: ROW })],
  ];
  for (const [name, run] of calls) {
    for (const [who, member] of [['a counter user', asCounter()], ['an owner at aal1', asAdmin('aal1')], ['nobody', null]] as const) {
      it(`${name}: ${who} is refused before the database or Storage is touched`, async () => {
        reset(member);
        healthy();
        expect(await run()).toEqual(forbidden);
        expect(state.calls).toEqual([]);
        expect(state.storageCalls).toEqual([]);
      });
    }
  }
});

describe('createAttachmentUpload', () => {
  it('hands out a signed address for a path the server builds', async () => {
    reset(asAdmin());
    healthy();
    const res = await createAttachmentUpload(request);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.path).toMatch(new RegExp(`^purchase_invoice/${BILL}/[0-9a-f-]{36}\\.jpg$`));
    expect(res.data.token).toBe('tok');
    expect(state.storageCalls[0]).toMatchObject({ bucket: 'docs', fn: 'createSignedUploadUrl' });
  });
  it('refuses a type outside jpeg/png/pdf, an oversize file and an empty one', async () => {
    reset(asAdmin());
    healthy();
    expect(await createAttachmentUpload({ ...request, mime: 'text/html' })).toMatchObject({ ok: false, code: 'validation', error: 'field.attachment_type_invalid' });
    expect(await createAttachmentUpload({ ...request, bytes: 5 * 1024 * 1024 + 1 })).toMatchObject({ ok: false, error: 'field.attachment_too_big' });
    expect(await createAttachmentUpload({ ...request, bytes: 0 })).toMatchObject({ ok: false, error: 'field.attachment_size_invalid' });
    expect(state.storageCalls).toEqual([]);
  });
  it('refuses an unknown bill, a cancelled bill and a bill that already has ten photos', async () => {
    reset(asAdmin());
    healthy(null);
    expect(await createAttachmentUpload(request)).toMatchObject({ ok: false, error: 'validation.no_such_bill' });
    healthy({ status: 'cancelled' });
    expect(await createAttachmentUpload(request)).toMatchObject({ ok: false, error: 'validation.attachment_entity_cancelled' });
    healthy({ status: 'posted' }, 10);
    expect(await createAttachmentUpload(request)).toMatchObject({ ok: false, error: 'validation.attachment_limit' });
    expect(state.storageCalls).toEqual([]);
  });
  it('a posted bill still takes a photo (evidence often arrives later)', async () => {
    reset(asAdmin());
    healthy({ status: 'posted' });
    expect((await createAttachmentUpload(request)).ok).toBe(true);
  });
});

describe('recordAttachment', () => {
  it('records the row from the stored file\'s own size and writes no stamp columns', async () => {
    reset(asAdmin());
    healthy();
    expect(await recordAttachment(record)).toEqual({ ok: true, data: { id: ROW, mime: 'image/jpeg', bytes: 1000 } });
    const payload = find('attachments', 'insert')?.payload as Record<string, unknown>;
    expect(payload).toEqual({ entity: 'purchase_invoice', entity_id: BILL, storage_path: PATH, mime: 'image/jpeg', bytes: 1000 });
    expect(state.revalidated).toEqual([`/purchases/${BILL}`, `/purchases/${BILL}/view`]);
  });
  it('refuses a path that is not the one built for this bill and type, before touching Storage', async () => {
    reset(asAdmin());
    healthy();
    for (const path of [
      `purchase_invoice/22222222-2222-4222-8222-222222222222/55555555-5555-4555-8555-555555555555.jpg`,
      `purchase_invoice/${BILL}/55555555-5555-4555-8555-555555555555.png`,
      `purchase_invoice/${BILL}/../x.jpg`,
      `other/${BILL}/55555555-5555-4555-8555-555555555555.jpg`,
    ]) {
      expect(await recordAttachment({ ...record, path })).toMatchObject({ ok: false, error: 'validation.attachment_path_invalid' });
    }
    expect(state.storageCalls).toEqual([]);
  });
  it('a file that never arrived is reported, nothing recorded', async () => {
    reset(asAdmin());
    healthy();
    state.storage.download = () => ({ data: null, error: { message: 'not found' } });
    expect(await recordAttachment(record)).toMatchObject({ ok: false, error: 'validation.attachment_object_missing' });
    expect(find('attachments', 'insert')).toBeUndefined();
  });
  it('a stored file of a different size than declared is thrown away', async () => {
    reset(asAdmin());
    healthy();
    state.storage.download = () => ({ data: jpeg(900), error: null });
    expect(await recordAttachment(record)).toMatchObject({ ok: false, error: 'validation.attachment_object_mismatch' });
    expect(removed()).toHaveLength(1);
    expect(find('attachments', 'insert')).toBeUndefined();
  });
  it('a web page labelled as a photo is thrown away', async () => {
    reset(asAdmin());
    healthy();
    state.storage.download = () => ({ data: html(1000), error: null });
    expect(await recordAttachment(record)).toMatchObject({ ok: false, error: 'validation.attachment_content_mismatch' });
    expect(removed()).toHaveLength(1);
    expect(find('attachments', 'insert')).toBeUndefined();
  });
  it('a database refusal removes the file again and is mapped (cancelled bill)', async () => {
    reset(asAdmin());
    healthy();
    const answer = state.respond;
    state.respond = (c) => (c.table === 'attachments' && c.op === 'insert' ? dbError('DN_VALIDATION:attachment_entity_cancelled') : answer(c));
    expect(await recordAttachment(record)).toMatchObject({ ok: false, error: 'validation.attachment_entity_cancelled' });
    expect(removed()).toHaveLength(1);
  });
  it('a repeat of the same path (unique violation) keeps the file the first call recorded', async () => {
    reset(asAdmin());
    healthy();
    const answer = state.respond;
    state.respond = (c) => (c.table === 'attachments' && c.op === 'insert' ? dbError('duplicate key value violates unique constraint "attachments_storage_path_key"', '23505') : answer(c));
    expect((await recordAttachment(record)).ok).toBe(false);
    expect(removed()).toHaveLength(0);
  });
});

describe('deleteAttachment', () => {
  it('removes the row first, then the file', async () => {
    reset(asAdmin());
    healthy();
    expect(await deleteAttachment({ id: ROW })).toEqual({ ok: true, data: null });
    expect(find('attachments', 'delete')).toBeDefined();
    expect(removed()[0]?.args).toEqual([[PATH]]);
  });
  it('a posted bill\'s photo stays: the database refusal is mapped and the file is untouched', async () => {
    reset(asAdmin());
    healthy();
    const answer = state.respond;
    state.respond = (c) => (c.table === 'attachments' && c.op === 'delete' ? dbError('DN_VALIDATION:attachment_bill_posted') : answer(c));
    expect(await deleteAttachment({ id: ROW })).toMatchObject({ ok: false, code: 'validation', error: 'validation.attachment_bill_posted' });
    expect(removed()).toHaveLength(0);
  });
  it('an unknown photo is reported', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: [] });
    expect(await deleteAttachment({ id: ROW })).toMatchObject({ ok: false, error: 'validation.attachment_missing' });
  });
});
