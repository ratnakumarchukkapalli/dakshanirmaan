import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import { EXPORT_KINDS, EXPORT_READY, TALLY_PARTS, exportHref, type ExportKind } from '@/lib/export/kinds';

/**
 * The three ways out: each card says in one sentence what the file holds, and either links to the
 * download or, for a kind whose route is not built yet, shows a disabled "coming next" button. The Tally
 * card has two downloads, in the order Tally needs them (ledgers, then vouchers).
 * A download opens in its own tab so an error message never replaces the screen.
 */
export async function ExportCards({ fyStartYear }: { fyStartYear: number }) {
  const t = await getTranslations('settings.export');
  return (
    <div className="exportgrid">
      {EXPORT_KINDS.map((kind: ExportKind) => (
        <Card key={kind} className="exportcard">
          <h2 className="cardtitle">{t(`${kind}.title`)}</h2>
          <p className="exportp">{t(`${kind}.body`)}</p>
          {kind === 'tally' && (
            <>
              <p className="hint exportp">{t('tally.note')}</p>
              <p className="hint exportp">{t('tally.numbering')}</p>
              <p className="hint exportp">{t('tally.inventory')}</p>
              {EXPORT_READY.tally && <p className="exportp exportorder">{t('tally.order')}</p>}
            </>
          )}
          {kind === 'tally' && EXPORT_READY.tally ? (
            <div className="exportbtns">
              {TALLY_PARTS.map((part) => (
                <a key={part} className="btn primary big" href={exportHref('tally', fyStartYear, part)} target="_blank" rel="noopener">
                  {t(part === 'masters' ? 'tally.buttonLedgers' : 'tally.buttonVouchers')}
                  <span className="vh"> {t('newTab')}</span>
                </a>
              ))}
            </div>
          ) : kind !== 'tally' && EXPORT_READY[kind] ? (
            <a className="btn primary big" href={exportHref(kind, fyStartYear)} target="_blank" rel="noopener">
              {t(`${kind}.button`)}
              <span className="vh"> {t('newTab')}</span>
            </a>
          ) : (
            <button type="button" className="btn ghost big" disabled aria-disabled="true">
              {t('comingNext')}
            </button>
          )}
        </Card>
      ))}
    </div>
  );
}
