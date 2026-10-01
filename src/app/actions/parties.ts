'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import { requireAdmin, requireMember } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import {
  createPartySchema, defaultSiteSchema, partyAddressSchema, partyIdSchema, updatePartyBasicsSchema, updatePartySchema,
} from '@/schemas/parties';

// Any active member may add or edit a party (the counter adds customers on the spot). Credit
// terms, salary, disabling and (on an existing party) type / GSTIN / state are owner-only: the
// actions leave those fields out for a counter user, and the database refuses them again.
// An owner who has not passed the authenticator step is refused everywhere.

/**
 * Credit-term columns, only for owners and only when the form actually gave a value.
 * "No credit limit" is NULL in the database (unlimited); 0 means no credit at all. A blank limit
 * on a new party is the conservative 0; on an existing party it means "leave as it is".
 */
function termsColumns(
  role: 'admin' | 'user',
  v: { creditLimit?: string; creditUnlimited?: boolean; creditDays?: string; interestRatePm?: string },
  fillDefaults: boolean,
) {
  if (role !== 'admin') return {};
  const cols: Record<string, string | null> = {};
  if (v.creditUnlimited) cols.credit_limit = null;
  else if (v.creditLimit !== undefined || fillDefaults) cols.credit_limit = v.creditLimit ?? '0';
  if (v.creditDays !== undefined || fillDefaults) cols.credit_days = v.creditDays ?? '0';
  if (v.interestRatePm !== undefined || fillDefaults) cols.interest_rate_pm = v.interestRatePm ?? '0';
  return cols;
}

export async function createParty(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const member = gate.member;
  const parsed = createPartySchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('parties')
    .insert({
      name: v.name, type: v.type, gstin: v.gstin ?? null, state_code: v.stateCode,
      phone: v.phone ?? null, whatsapp_phone: v.whatsappPhone ?? null,
      ...termsColumns(member.role, v, true),
    })
    .select('id')
    .single();
  if (error) return dbFailure(error);

  revalidatePath('/parties');
  return ok({ id: data.id as string });
}

export async function updateParty(input: unknown): Promise<ActionResult> {
  const t = await getTranslations('errors');
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const member = gate.member;
  const supabase = await createClient();

  let columns: Record<string, string | null>;
  let id: string;
  if (member.role === 'admin') {
    const parsed = updatePartySchema.safeParse(input);
    if (!parsed.success) return zodFailure(parsed.error);
    const { id: partyId, ...v } = parsed.data;
    id = partyId;
    columns = {
      name: v.name, type: v.type, gstin: v.gstin ?? null, state_code: v.stateCode,
      phone: v.phone ?? null, whatsapp_phone: v.whatsappPhone ?? null,
      ...termsColumns(member.role, v, false),
    };
  } else {
    // Type, GSTIN, state and credit terms are owner-only once a party exists (the database
    // refuses them too), so a counter user's input is not even checked against them.
    const parsed = updatePartyBasicsSchema.safeParse(input);
    if (!parsed.success) return zodFailure(parsed.error);
    const { id: partyId, ...v } = parsed.data;
    id = partyId;
    columns = { name: v.name, phone: v.phone ?? null, whatsapp_phone: v.whatsappPhone ?? null };
  }

  const { data, error } = await supabase.from('parties').update(columns).eq('id', id).select('id');
  if (error) return dbFailure(error);
  if (!data?.length) return fail('validation', t('validation.no_such_party'));

  revalidatePath('/parties');
  revalidatePath(`/parties/${id}`);
  return ok();
}

export async function addPartyAddress(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = partyAddressSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { partyId, label, stateCode, line1, line2, city, district, pincode } = parsed.data;

  const supabase = await createClient();
  // A party's first address becomes its billing address (it sets the default place of supply).
  const { count } = await supabase.from('party_addresses').select('id', { count: 'exact', head: true }).eq('party_id', partyId);
  const { data, error } = await supabase
    .from('party_addresses')
    .insert({
      party_id: partyId, label, state_code: stateCode, is_default: (count ?? 0) === 0,
      address: { line1, line2: line2 ?? null, city, district: district ?? null, pincode },
    })
    .select('id')
    .single();
  if (error) {
    // Counter staff may add a delivery site in the party's own state only: another state decides the tax head, so it is the owner's call.
    if (/DN_VALIDATION:admin_only_field/.test(error.message ?? '')) return fail('validation', (await getTranslations('errors'))('validation.site_state_owner_only'));
    return dbFailure(error);
  }

  revalidatePath(`/parties/${partyId}`);
  return ok({ id: data.id as string });
}

/** Pre-selects a delivery site on billing. The database only accepts one of the party's own addresses. */
export async function setDefaultSite(input: unknown): Promise<ActionResult> {
  const t = await getTranslations('errors');
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = defaultSiteSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { partyId, addressId } = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase.from('parties').update({ default_site_id: addressId }).eq('id', partyId).select('id');
  if (error) return dbFailure(error);
  if (!data?.length) return fail('validation', t('validation.no_such_party'));

  revalidatePath(`/parties/${partyId}`);
  return ok();
}

async function setActive(input: unknown, active: boolean): Promise<ActionResult> {
  const t = await getTranslations('errors');
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = partyIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase.from('parties').update({ is_active: active }).eq('id', parsed.data.partyId).select('id');
  if (error) return dbFailure(error);
  if (!data?.length) return fail('validation', t('validation.no_such_party'));

  revalidatePath('/parties');
  revalidatePath(`/parties/${parsed.data.partyId}`);
  // An employee is disabled from the staff screen through this same action.
  revalidatePath('/staff');
  revalidatePath(`/staff/${parsed.data.partyId}`);
  return ok();
}

export async function deactivateParty(input: unknown): Promise<ActionResult> {
  return setActive(input, false);
}

export async function reactivateParty(input: unknown): Promise<ActionResult> {
  return setActive(input, true);
}
