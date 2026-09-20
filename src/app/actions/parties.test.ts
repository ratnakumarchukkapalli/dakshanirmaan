import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state } from '@/test/harness';
import { addPartyAddress, createParty, deactivateParty, reactivateParty, setDefaultSite, updateParty } from './parties';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const ID = '11111111-1111-4111-8111-111111111111';
const ADDR = '22222222-2222-4222-8222-222222222222';
const form = {
  name: 'Ramesh Builders', type: 'customer', stateCode: '37', gstin: '', phone: '', whatsappPhone: '',
  creditLimit: '', creditDays: '', interestRatePm: '',
};
const sent = () => state.calls.find((c) => c.op === 'insert' || c.op === 'update')?.payload;

describe('createParty', () => {
  it('owner (aal2): saves, with a blank credit limit meaning 0 and "unlimited" meaning NULL', async () => {
    reset(asAdmin());
    expect(await createParty(form)).toEqual({ ok: true, data: { id: 'row-1' } });
    expect(sent()).toMatchObject({ name: 'Ramesh Builders', credit_limit: '0', credit_days: '0', interest_rate_pm: '0' });
    expect(state.revalidated).toContain('/parties');

    reset(asAdmin());
    await createParty({ ...form, creditUnlimited: true, creditLimit: '5000' });
    expect(sent()).toHaveProperty('credit_limit', null);

    reset(asAdmin());
    await createParty({ ...form, creditLimit: '250000.50', creditDays: '30', interestRatePm: '1.5' });
    expect(sent()).toMatchObject({ credit_limit: '250000.50', credit_days: '30', interest_rate_pm: '1.5' });
  });
  it('owner at aal1 is refused before the database is touched', async () => {
    reset(asAdmin('aal1'));
    expect(await createParty(form)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('no signed-in member is refused', async () => {
    reset(null);
    expect(await createParty(form)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('counter user (aal1) may create a party, but credit terms are never sent', async () => {
    reset(asCounter());
    expect((await createParty({ ...form, creditLimit: '99999', creditUnlimited: true, creditDays: '90' })).ok).toBe(true);
    const payload = sent()!;
    expect(payload).toMatchObject({ name: 'Ramesh Builders', type: 'customer', state_code: '37' });
    expect(payload).not.toHaveProperty('credit_limit');
    expect(payload).not.toHaveProperty('credit_days');
    expect(payload).not.toHaveProperty('interest_rate_pm');
  });
  it('bad input is a validation failure and never reaches the database', async () => {
    reset(asAdmin());
    expect(await createParty({ ...form, name: '' })).toMatchObject({ ok: false, code: 'validation', error: 'field.name_required' });
    expect(state.calls).toHaveLength(0);
  });
  it('a duplicate GSTIN maps to a friendly message, not Postgres text', async () => {
    reset(asAdmin());
    state.respond = () => dbError('duplicate key value violates unique constraint "parties_gstin_key"', '23505');
    expect(await createParty(form)).toEqual({ ok: false, code: 'validation', error: 'validation.gstin_taken' });
  });
  it('an unknown database failure is hidden behind "internal"', async () => {
    reset(asAdmin());
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.respond = () => dbError('connection to server at 10.0.0.5 lost');
    const r = await createParty(form);
    expect(r).toEqual({ ok: false, code: 'internal', error: 'internal' });
    spy.mockRestore();
  });
});

describe('updateParty', () => {
  const edit = { id: ID, ...form };

  it('owner (aal2) may change type, GSTIN, state and credit terms; "unlimited" sets NULL; blank limit leaves it alone', async () => {
    reset(asAdmin());
    expect(await updateParty({ ...edit, type: 'both', creditUnlimited: true })).toEqual({ ok: true, data: null });
    expect(sent()).toMatchObject({ type: 'both', gstin: null, state_code: '37', credit_limit: null });
    expect(state.revalidated).toEqual(['/parties', `/parties/${ID}`]);

    reset(asAdmin());
    await updateParty(edit);
    const payload = sent()!;
    expect(payload).not.toHaveProperty('credit_limit');
    expect(payload).not.toHaveProperty('credit_days');
    expect(payload).toHaveProperty('type', 'customer');
  });
  it('counter user: type, GSTIN, state and credit terms are stripped from what is sent', async () => {
    reset(asCounter());
    const r = await updateParty({ ...edit, type: 'supplier', stateCode: '36', creditLimit: '1000', creditUnlimited: true, creditDays: '10', interestRatePm: '2' });
    expect(r.ok).toBe(true);
    const payload = sent()!;
    expect(Object.keys(payload).sort()).toEqual(['name', 'phone', 'whatsapp_phone']);
  });
  it('owner at aal1 is refused before the database is touched', async () => {
    reset(asAdmin('aal1'));
    expect(await updateParty(edit)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('maps the database rule about a party that still has a balance', async () => {
    reset(asAdmin());
    state.respond = () => dbError('DN_VALIDATION:party_type_has_balance');
    expect(await updateParty({ ...edit, type: 'supplier' })).toEqual({ ok: false, code: 'validation', error: 'validation.party_type_has_balance' });
  });
  it('maps the counter-user refusal from the database', async () => {
    reset(asCounter());
    state.respond = () => dbError('DN_VALIDATION:admin_only_field');
    expect(await updateParty(edit)).toEqual({ ok: false, code: 'validation', error: 'validation.admin_only_field' });
  });
  it('a party that does not exist (or cannot be seen) says so', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: [], error: null });
    expect(await updateParty(edit)).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_party' });
  });
  it('a number too big for its column is a validation problem', async () => {
    reset(asAdmin());
    state.respond = () => dbError('numeric field overflow', '22003');
    expect(await updateParty(edit)).toEqual({ ok: false, code: 'validation', error: 'validation.number_too_large' });
  });
});

describe('addPartyAddress / setDefaultSite', () => {
  const site = { partyId: ID, label: 'Site A', stateCode: '37', line1: '12-3 Main Road', city: 'Vijayawada', pincode: '520001' };

  it('counter user (aal1) may add a site; the first one becomes the billing address', async () => {
    reset(asCounter());
    state.respond = (c) => (c.op === 'select' ? { count: 0 } : { data: [{ id: 'addr-1' }], error: null });
    expect(await addPartyAddress(site)).toEqual({ ok: true, data: { id: 'addr-1' } });
    expect(state.calls.find((c) => c.op === 'insert')?.payload).toMatchObject({ party_id: ID, is_default: true });
    expect(state.revalidated).toEqual([`/parties/${ID}`]);
  });
  it('owner at aal1 is refused, for both', async () => {
    reset(asAdmin('aal1'));
    expect(await addPartyAddress(site)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await setDefaultSite({ partyId: ID, addressId: ADDR })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('maps "a site cannot move to another party"', async () => {
    reset(asCounter());
    state.respond = () => dbError('DN_VALIDATION:address_party_locked');
    expect(await setDefaultSite({ partyId: ID, addressId: ADDR })).toEqual({ ok: false, code: 'validation', error: 'validation.address_party_locked' });
  });
  it('setDefaultSite saves for a counter user', async () => {
    reset(asCounter());
    expect(await setDefaultSite({ partyId: ID, addressId: ADDR })).toEqual({ ok: true, data: null });
    expect(sent()).toEqual({ default_site_id: ADDR });
  });
});

describe('deactivateParty / reactivateParty (owner only)', () => {
  it('owner (aal2) can disable and enable', async () => {
    reset(asAdmin());
    expect((await deactivateParty({ partyId: ID })).ok).toBe(true);
    expect(sent()).toEqual({ is_active: false });
    reset(asAdmin());
    expect((await reactivateParty({ partyId: ID })).ok).toBe(true);
    expect(sent()).toEqual({ is_active: true });
  });
  it('owner at aal1 is refused before the database is touched', async () => {
    reset(asAdmin('aal1'));
    expect(await deactivateParty({ partyId: ID })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('counter user is refused', async () => {
    reset(asCounter());
    expect(await deactivateParty({ partyId: ID })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await reactivateParty({ partyId: ID })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('maps the database rule about an outstanding balance, and a missing party', async () => {
    reset(asAdmin());
    state.respond = () => dbError('DN_VALIDATION:party_has_balance');
    expect(await deactivateParty({ partyId: ID })).toEqual({ ok: false, code: 'validation', error: 'validation.party_has_balance' });
    state.respond = () => ({ data: [], error: null });
    expect(await deactivateParty({ partyId: ID })).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_party' });
  });
});
