import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state } from '@/test/harness';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

import { updateOrganization } from './organization';

const org = {
  legalName: 'Daksha Nirmaan Traders', tradeName: '', gstin: '', stateCode: '37',
  address: { line1: 'D.No 12-3-45, Main Road', line2: '', city: 'Vijayawada', district: '', pincode: '521137' },
  fyStartMonth: '4', invoiceBankDetails: '', upiVpa: '', invoiceFooter: '', einvoiceEnabled: false, allowNegativeStock: false,
};

describe('updateOrganization', () => {
  it('owner (aal2) saves and both the settings page and the shell are refreshed', async () => {
    reset(asAdmin());
    expect(await updateOrganization(org)).toEqual({ ok: true, data: null });
    expect(state.calls[0]).toMatchObject({ table: 'organization', op: 'update' });
    expect(state.calls[0]!.payload).toMatchObject({ legal_name: 'Daksha Nirmaan Traders', fy_start_month: 4, state_code: '37' });
    expect(state.revalidated).toContain('/settings/organisation');
  });
  it('owner at aal1 is refused before the database is touched', async () => {
    reset(asAdmin('aal1'));
    expect(await updateOrganization(org)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('counter user is refused', async () => {
    reset(asCounter());
    expect(await updateOrganization(org)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('maps "state is locked once invoices exist"', async () => {
    reset(asAdmin());
    state.respond = () => dbError('DN_VALIDATION:org_state_locked');
    expect(await updateOrganization(org)).toEqual({ ok: false, code: 'validation', error: 'validation.org_state_locked' });
  });
  it('zero rows updated (the database refused the write) reads as forbidden', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: [], error: null });
    expect(await updateOrganization(org)).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
