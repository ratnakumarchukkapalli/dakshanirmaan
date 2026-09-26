import { getTranslations } from 'next-intl/server';

/**
 * Shown at once while a screen's data loads (the shell around it stays put). Without this a click
 * looks dead until the server answers, and Next.js cannot prefetch the shell of a dynamic page.
 */
export default async function Loading() {
  const t = await getTranslations('a11y');
  return (
    <div className="screen" role="status" aria-busy="true" aria-label={t('loading')}>
      <div className="skel title" />
      <div className="tiles">
        <div className="skel tile" />
        <div className="skel tile" />
        <div className="skel tile" />
        <div className="skel tile" />
      </div>
      <div className="skel card" />
    </div>
  );
}
