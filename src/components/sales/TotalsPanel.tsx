import { inr2 } from '@/lib/format';

export interface TotalsData {
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  roundOff: string;
  grandTotal: string;
}

interface Labels {
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  roundOff: string;
  total: string;
}

/**
 * The totals rows. The billing form feeds it the live preview; the posted view feeds it the
 * figures the database stored. Only the tax lines that apply are shown.
 */
export function TotalsRows({ totals, labels, intra }: { totals: TotalsData; labels: Labels; intra: boolean }) {
  const zero = (v: string) => Number(v) === 0;
  return (
    <div className="totals">
      <div className="row"><span>{labels.taxable}</span><b className="num">{inr2(totals.taxable)}</b></div>
      {intra ? (
        <>
          <div className="row"><span>{labels.cgst}</span><span className="num">{inr2(totals.cgst)}</span></div>
          <div className="row"><span>{labels.sgst}</span><span className="num">{inr2(totals.sgst)}</span></div>
        </>
      ) : (
        <div className="row"><span>{labels.igst}</span><span className="num">{inr2(totals.igst)}</span></div>
      )}
      {!zero(totals.roundOff) && (
        <div className="row"><span>{labels.roundOff}</span><span className="num">{Number(totals.roundOff) > 0 ? '+' : ''}{inr2(totals.roundOff)}</span></div>
      )}
      <div className="row grand"><span>{labels.total}</span><span className="num" data-testid="grand-total">{inr2(totals.grandTotal)}</span></div>
    </div>
  );
}
