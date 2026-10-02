'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { importBankStatement, type ImportResult } from '@/app/actions/bank';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { parseHdfcStatement, type ParsedLine } from '@/lib/bank-statement/hdfc';
import { formatDate, inr2 } from '@/lib/format';

// Server actions accept about 1 MB; the longest statement worth importing in one go stays well under it.
const MAX_PAYLOAD_BYTES = 900_000;

type Preview = {
  fileName: string;
  lines: ParsedLine[];
  firstDate: string;
  lastDate: string;
  openingBalance: string | null;
  closingBalance: string | null;
  warnings: string[];
};

/**
 * Upload card: the file is read in the browser, shown as a preview, and only the parsed rows are sent when the
 * owner presses Import. The file itself never leaves the browser.
 */
export function ImportCard() {
  const t = useTranslations('bank');
  const tc = useTranslations('common');
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setPreview(null);
    setRefusal(null);
    setFailure(null);
    setResult(null);
    if (input.current) input.current.value = '';
  }

  async function onFile(file: File | undefined) {
    setPreview(null);
    setRefusal(null);
    setFailure(null);
    setResult(null);
    if (!file) return;
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await parseHdfcStatement({ name: file.name, bytes });
      if (!parsed.ok) return setRefusal(parsed.error);
      const { lines, summary } = parsed;
      if (lines.some((l) => l.balance === null)) return setRefusal(t('noBalances'));
      if (new Blob([JSON.stringify(lines)]).size > MAX_PAYLOAD_BYTES) return setRefusal(t('tooBig'));
      setPreview({
        fileName: file.name, lines, firstDate: summary.firstDate, lastDate: summary.lastDate,
        openingBalance: summary.openingBalance, closingBalance: summary.closingBalance, warnings: summary.warnings,
      });
    } catch {
      setRefusal(t('unreadable'));
    } finally {
      setReading(false);
    }
  }

  function run() {
    if (!preview) return;
    setFailure(null);
    start(async () => {
      try {
        const res = await importBankStatement({ fileName: preview.fileName, lines: preview.lines });
        if (!res.ok) return setFailure(res.error);
        setPreview(null);
        setResult(res.data);
        if (input.current) input.current.value = '';
        router.refresh();
      } catch {
        // A thrown action (body too large, network down): the statement may or may not have been saved.
        setFailure(t('importFailed'));
      }
    });
  }

  const shown = preview ? (preview.lines.length > 10 ? [...preview.lines.slice(0, 5), null, ...preview.lines.slice(-5)] : preview.lines) : [];
  const chargeCount = preview ? preview.lines.filter((l) => l.kind === 'charge').length : 0;

  return (
    <Card>
      <div className="cardtitle">{t('uploadTitle')}</div>
      <p className="hint" style={{ marginTop: 0 }}>{t('uploadHint')}</p>
      <div className="field">
        <label htmlFor="bank-file">{t('fileLabel')}</label>
        <input
          id="bank-file" ref={input} type="file" accept=".txt,.csv,.xlsx" disabled={reading || pending}
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </div>
      {reading && <p className="hint" role="status">{t('reading')}</p>}
      {refusal && <p role="alert" className="alert bad">{refusal}</p>}

      {preview && (
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="tiles">
            <div className="tile"><div className="lbl">{t('previewFile')}</div><div className="val small" style={{ overflowWrap: 'anywhere' }}>{preview.fileName}</div></div>
            <div className="tile"><div className="lbl">{t('previewRows')}</div><div className="val num small">{preview.lines.length}</div></div>
            <div className="tile">
              <div className="lbl">{t('previewPeriod')}</div>
              <div className="val num small">{formatDate(preview.firstDate)}</div>
              <div className="sub">{t('previewTo', { date: formatDate(preview.lastDate) })}</div>
            </div>
            <div className="tile">
              <div className="lbl">{t('previewOpening')}</div>
              <div className="val num small">{preview.openingBalance === null ? '—' : inr2(preview.openingBalance)}</div>
            </div>
            <div className="tile">
              <div className="lbl">{t('previewClosing')}</div>
              <div className="val num small">{preview.closingBalance === null ? '—' : inr2(preview.closingBalance)}</div>
            </div>
          </div>
          {preview.warnings.map((w) => <p key={w} className="alert warn" role="status">{w}</p>)}
          {chargeCount > 0 && <p className="hint" style={{ margin: 0 }}>{t('previewCharges', { n: chargeCount })}</p>}
          <div className="tablewrap">
            <table className="stacktable">
              <thead>
                <tr>
                  <th>{t('colDate')}</th><th>{t('colNarration')}</th><th className="r">{t('colOut')}</th><th className="r">{t('colIn')}</th><th className="r">{t('colBalance')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l, i) =>
                  l === null ? (
                    <tr key={`gap-${i}`} className="bf"><td colSpan={5} className="r">{t('previewGap', { n: preview.lines.length - 10 })}</td></tr>
                  ) : (
                    <tr key={l.lineNo}>
                      <td className="nowrap" data-label={t('colDate')}>{formatDate(l.txnDate)}</td>
                      <td className="wide" data-label={t('colNarration')} style={{ overflowWrap: 'anywhere' }}>
                        {l.narration} {l.kind === 'charge' && <Chip tone="warn">{t('chargeTag')}</Chip>}
                      </td>
                      <td className="r num" data-label={t('colOut')}>{l.debit === '0.00' ? '' : inr2(l.debit)}</td>
                      <td className="r num" data-label={t('colIn')}>{l.credit === '0.00' ? '' : inr2(l.credit)}</td>
                      <td className="r num" data-label={t('colBalance')}>{l.balance === null ? '' : inr2(l.balance)}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ margin: 0 }}>{t('previewNotSaved')}</p>
          {failure && <p role="alert" className="alert bad">{failure}</p>}
          <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
            <button type="button" className="btn primary big" disabled={pending} onClick={run}>{pending ? t('importing') : t('importBtn')}</button>
            <button type="button" className="btn ghost big" disabled={pending} onClick={reset}>{tc('cancel')}</button>
          </div>
        </div>
      )}

      {result && (
        <div className="stack" style={{ marginTop: 12 }} role="status">
          <p className="alert good">
            {result.imported === 0 ? t('resultNothingNew') : t('resultImported', { n: result.imported })}
            {result.skippedDuplicates > 0 && <> {t('resultSkipped', { n: result.skippedDuplicates })}</>}
          </p>
          {result.continuityWarning && (
            <p className="alert warn">
              {t('resultContinuity', { opening: inr2(result.openingBalance), previous: result.previousClosingBalance === null ? '—' : inr2(result.previousClosingBalance) })}
            </p>
          )}
          <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
            {result.statementId && <Link href={`/reports/reconcile/${result.statementId}`} className="btn primary big">{t('openStatement')}</Link>}
            <button type="button" className="btn ghost big" onClick={reset}>{t('importAnother')}</button>
          </div>
        </div>
      )}
    </Card>
  );
}
