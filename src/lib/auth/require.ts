import 'server-only';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { fail, type Failure } from '@/lib/action-result';
import { getCurrentMember, type CurrentMember } from '@/lib/auth/current';

/** True for an owner who has passed the authenticator step (JWT level aal2). */
export const isVerifiedAdmin = (member: CurrentMember | null): boolean =>
  member?.role === 'admin' && member.aal === 'aal2';

/** Owner who has passed the authenticator step, or a refusal. The database checks again. */
export async function requireAdmin(): Promise<Failure | null> {
  if (isVerifiedAdmin(await getCurrentMember())) return null;
  return fail('forbidden', (await getTranslations('errors'))('forbidden'));
}

export type MemberGate = { member: CurrentMember; denied?: undefined } | { member?: undefined; denied: Failure };

/**
 * Any active member, except an owner who has not passed the authenticator step: an owner at
 * aal1 holds only half a sign-in and gets nothing. Counter staff (role `user`) have no
 * authenticator, so aal1 is normal for them.
 */
export async function requireMember(): Promise<MemberGate> {
  const member = await getCurrentMember();
  if (member && (member.role !== 'admin' || member.aal === 'aal2')) return { member };
  return { denied: fail('forbidden', (await getTranslations('errors'))('forbidden')) };
}

/** A verified owner (authenticator step passed), with their session facts; anyone else gets the refusal. */
export async function requireAdminMember(): Promise<MemberGate> {
  const member = await getCurrentMember();
  if (member && isVerifiedAdmin(member)) return { member };
  return { denied: fail('forbidden', (await getTranslations('errors'))('forbidden')) };
}

/**
 * The second lock on an owner-only screen (the proxy is the first): a verified owner passes, anyone
 * else is sent to the dashboard. Called at the top of every page, not only a layout, because a
 * layout is not re-run when the person moves between its pages.
 */
export async function requireOwnerPage(): Promise<CurrentMember> {
  const member = await getCurrentMember();
  if (!member || !isVerifiedAdmin(member)) redirect('/');
  return member;
}
