'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deactivateParty, reactivateParty } from '@/app/actions/parties';

/** Owner-only. The database refuses to disable a party that still has a balance. */
export function PartyStatusButton({ partyId, isActive }: { partyId: string; isActive: boolean }) {
  const t = useTranslations('parties');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = () =>
    start(async () => {
      setError(null);
      const res = await (isActive ? deactivateParty : reactivateParty)({ partyId });
      if (!res.ok) setError(res.error);
      else router.refresh();
    });

  return (
    <div>
      {error && <p role="alert" className="alert bad">{error}</p>}
      <button type="button" className={`btn sm ${isActive ? 'danger' : 'ghost'}`} disabled={pending} onClick={toggle}>
        {isActive ? t('disable') : t('enable')}
      </button>
    </div>
  );
}
