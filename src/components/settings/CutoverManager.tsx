'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  addOpeningMoneyLine, addOpeningPartyLine, addOpeningStockLine, cancelOpening, importOpeningStock, postOpening, removeOpeningLine,
} from '@/app/actions/cutover';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { DateField } from '@/components/ui/DateField';
import { Field } from '@/components/ui/Field';
import { Picker, type PickerOption } from '@/components/ui/Picker';
import { StatTile } from '@/components/ui/StatTile';
import type { CutoverData } from '@/lib/cutover-data';
import type { ActionResult } from '@/lib/action-result';
import { formatDate, inr2, inrRate } from '@/lib/format';

/**
 * Owner-only cutover screen: stage the opening dues, cash/bank and stock as lines of one draft batch,
 * check the database's own preview of the totals, then post. Nothing is added up here.
 */
export function CutoverManager({ data }: { data: CutoverData }) {
  const t = useTranslations('cutover');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const posted = data.batch?.status === 'posted';

  /** Runs an action; refreshes the page when it worked, shows its sentence when it did not. */
  const run: Run = (call, onOk) => {
    setFailure(null);
    setNotice(null);
    start(async () => {
      const res = await call();
      if (!res.ok) return setFailure(res.error);
      onOk?.(res.data as never);
      router.refresh();
    });
  };

  return (
    <div className="stack">
      <p className="hint" style={{ margin: 0 }}>{t('intro')}</p>
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      {notice && <p role="status" className="alert good">{notice}</p>}

      {!posted && (
        <>
          <DuesForm data={data} pending={pending} run={run} />
          <MoneyForm data={data} pending={pending} run={run} />
          <StockForm data={data} pending={pending} run={run} setNotice={setNotice} />
        </>
      )}

      <LinesCard data={data} pending={pending} run={run} />

      {posted ? <PostedCard data={data} pending={pending} run={run} /> : <PostCard data={data} pending={pending} run={run} />}

      <Checklist data={data} />
    </div>
  );
}

type Run = <T>(call: () => Promise<ActionResult<T>>, onOk?: (data: T) => void) => void;
interface FormProps { data: CutoverData; pending: boolean; run: Run }

function DuesForm({ data, pending, run }: FormProps) {
  const t = useTranslations('cutover');
  const [partyId, setPartyId] = useState('');
  const [side, setSide] = useState<'receivable' | 'payable'>('receivable');
  const [amount, setAmount] = useState('');
  const options = useMemo<PickerOption[]>(
    () => data.parties.map((p) => ({ id: p.id, title: p.name, sub: p.phone ?? undefined, search: `${p.name} ${p.phone ?? ''}`.toLowerCase() })),
    [data.parties],
  );
  const pick = (id: string) => {
    setPartyId(id);
    const type = data.parties.find((p) => p.id === id)?.type;
    if (type === 'customer') setSide('receivable');
    if (type === 'supplier') setSide('payable');
  };
  const type = data.parties.find((p) => p.id === partyId)?.type;
  return (
    <Card>
      <div className="cardtitle">{t('dues.title')}</div>
      <p className="hint">{t('dues.hint')}</p>
      <div className="fieldrow">
        <Field id="cut-party" label={t('dues.party')}>
          <Picker id="cut-party" options={options} value={partyId} onPick={pick} placeholder={t('dues.chooseParty')} dialogTitle={t('dues.chooseParty')}
            searchLabel={t('dues.searchParty')} emptyText={t('dues.noParties')} closeLabel={t('close')} />
        </Field>
        <Field id="cut-side" label={t('dues.side')}>
          <select id="cut-side" value={side} onChange={(e) => setSide(e.target.value as 'receivable' | 'payable')}>
            <option value="receivable" disabled={type === 'supplier'}>{t('dues.receivable')}</option>
            <option value="payable" disabled={type === 'customer'}>{t('dues.payable')}</option>
          </select>
        </Field>
        <Field id="cut-due-amount" label={t('dues.amount')}>
          <input id="cut-due-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </div>
      <button type="button" className="btn primary" disabled={pending || !partyId} onClick={() => run(() => addOpeningPartyLine({ partyId, side, amount }), () => { setAmount(''); setPartyId(''); })}>
        {t('add')}
      </button>
    </Card>
  );
}

function MoneyForm({ data, pending, run }: FormProps) {
  const t = useTranslations('cutover');
  const [accountId, setAccountId] = useState(data.accounts[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  return (
    <Card>
      <div className="cardtitle">{t('money.title')}</div>
      <p className="hint">{t('money.hint')}</p>
      <div className="fieldrow">
        <Field id="cut-account" label={t('money.account')}>
          <select id="cut-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field id="cut-money-amount" label={t('money.amount')}>
          <input id="cut-money-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </div>
      <button type="button" className="btn primary" disabled={pending || !accountId} onClick={() => run(() => addOpeningMoneyLine({ accountId, amount }), () => setAmount(''))}>
        {t('add')}
      </button>
    </Card>
  );
}

function StockForm({ data, pending, run, setNotice }: FormProps & { setNotice: (s: string | null) => void }) {
  const t = useTranslations('cutover');
  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState(data.godowns[0]?.id ?? '');
  const [qty, setQty] = useState('');
  const [rate, setRate] = useState('');
  const [reading, setReading] = useState(false);
  const options = useMemo<PickerOption[]>(
    () => data.items.map((i) => ({ id: i.id, title: i.name, sub: i.baseUom, search: `${i.name} ${i.brand ?? ''}`.toLowerCase() })),
    [data.items],
  );
  const uom = data.items.find((i) => i.id === itemId)?.baseUom;

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    const csv = await file.text();
    setReading(false);
    run(() => importOpeningStock({ csv }), (r) => setNotice(t('stock.imported', { count: r.added })));
  };

  return (
    <Card>
      <div className="cardtitle">{t('stock.title')}</div>
      <p className="hint">{t('stock.hint')}</p>
      <div className="fieldrow">
        <Field id="cut-item" label={t('stock.item')}>
          <Picker id="cut-item" options={options} value={itemId} onPick={setItemId} placeholder={t('stock.chooseItem')} dialogTitle={t('stock.chooseItem')}
            searchLabel={t('stock.searchItem')} emptyText={t('stock.noItems')} closeLabel={t('close')} />
        </Field>
        <Field id="cut-godown" label={t('stock.godown')}>
          <select id="cut-godown" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {data.godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <Field id="cut-qty" label={uom ? `${t('stock.qty')} (${uom})` : t('stock.qty')}>
          <input id="cut-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field id="cut-rate" label={t('stock.rate')}>
          <input id="cut-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
      </div>
      <button type="button" className="btn primary" disabled={pending || !itemId || !warehouseId}
        onClick={() => run(() => addOpeningStockLine({ itemId, warehouseId, qty, rate }), () => { setQty(''); setRate(''); setItemId(''); })}>
        {t('add')}
      </button>

      <div className="cardtitle" style={{ marginTop: 18 }}>{t('stock.csvTitle')}</div>
      <p className="hint">{t('stock.csvHint')}</p>
      <Field id="cut-csv" label={t('stock.csvChoose')}>
        <input id="cut-csv" type="file" accept=".csv,text/csv" disabled={pending || reading}
          onChange={async (e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            await importFile(file);
            input.value = '';
          }} />
      </Field>
      {reading && <p className="hint">{t('stock.csvReading')}</p>}
    </Card>
  );
}

function LinesCard({ data, pending, run }: FormProps) {
  const t = useTranslations('cutover');
  const posted = data.batch?.status === 'posted';
  const p = data.preview;
  return (
    <Card>
      <div className="cardtitle">{t('lines.title')}</div>
      {!posted && (
        <div className="tiles">
          <StatTile small label={t('summary.receivable')} value={inr2(p.receivable)} />
          <StatTile small label={t('summary.payable')} value={inr2(p.payable)} />
          <StatTile small label={t('summary.money')} value={inr2(p.money)} />
          <StatTile small label={t('summary.stock')} value={inr2(p.stock)} />
          <StatTile small hero label={t('summary.equity')} value={inr2(p.equity)} sub={t('summary.equityHint')} />
        </div>
      )}
      {data.lines.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{t('lines.empty')}</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th>{t('lines.what')}</th><th>{t('lines.detail')}</th><th className="r">{t('lines.amount')}</th>{!posted && <th />}</tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.kind === 'party' ? t(l.side === 'receivable' ? 'lines.receivable' : 'lines.payable', { name: l.name }) : l.name}</td>
                  <td className="num">
                    {l.kind === 'stock' ? t('lines.stockDetail', { qty: l.qty ?? '', uom: l.uom ?? '', rate: inrRate(l.rate), godown: l.godown ?? '' }) : '—'}
                  </td>
                  <td className="r num">{l.amount === null ? '—' : inr2(l.amount)}</td>
                  {!posted && (
                    <td>
                      <button type="button" className="btn ghost sm" disabled={pending} onClick={() => run(() => removeOpeningLine({ id: l.id }))}>{t('remove')}</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PostCard({ data, pending, run }: FormProps) {
  const t = useTranslations('cutover');
  const [date, setDate] = useState(data.defaultDate);
  return (
    <Card>
      <div className="cardtitle">{t('post.title')}</div>
      <p className="hint">{t('post.hint')}</p>
      <div className="fieldrow">
        <Field id="cut-date" label={t('post.date')} className="datefield">
          <DateField id="cut-date" value={date} onChange={setDate} placeholder="DD-MM-YYYY" />
        </Field>
      </div>
      <button type="button" className="btn primary" disabled={pending || data.preview.lineCount === 0 || !date}
        onClick={() => run(() => postOpening({ date, expectedEquity: data.preview.equity }))}>
        {pending ? t('post.posting') : t('post.button')}
      </button>
    </Card>
  );
}

function PostedCard({ data, pending, run }: FormProps) {
  const t = useTranslations('cutover');
  const [reason, setReason] = useState('');
  return (
    <Card>
      <div className="cardtitle">{t('posted.title', { date: data.batch?.asOf ? formatDate(data.batch.asOf) : '' })}</div>
      <p className="hint">{t('posted.body')}</p>
      <div className="cardtitle" style={{ marginTop: 14 }}>{t('posted.cancelTitle')}</div>
      <p className="hint">{t('posted.cancelHint')}</p>
      <div className="fieldrow">
        <Field id="cut-reason" label={t('posted.reason')}>
          <input id="cut-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
      </div>
      <button type="button" className="btn danger" disabled={pending || reason.trim().length < 3} onClick={() => run(() => cancelOpening({ reason }), () => setReason(''))}>
        {pending ? t('posted.cancelling') : t('posted.cancelBtn')}
      </button>
    </Card>
  );
}

const CHECKS = ['organisation', 'owners', 'periods', 'opening_posted', 'ledger_balanced', 'inventory_ties', 'bank_set_up'] as const;
const MANUAL = ['otp', 'totp', 'backup', 'book', 'demo', 'tally'] as const;

function Checklist({ data }: { data: CutoverData }) {
  const t = useTranslations('cutover');
  const ok = new Map(data.readiness.map((r) => [r.key, r.ok]));
  return (
    <Card>
      <div className="cardtitle">{t('checklist.title')}</div>
      <p className="hint">{t('checklist.hint')}</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        {CHECKS.map((k) => (
          <li key={k} style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{t(`checklist.${k}`)}</span>
            <Chip tone={ok.get(k) ? 'good' : 'warn'}>{ok.get(k) ? t('checklist.ready') : t('checklist.todo')}</Chip>
          </li>
        ))}
      </ul>
      <div className="cardtitle" style={{ marginTop: 16 }}>{t('checklist.manualTitle')}</div>
      <p className="hint">{t('checklist.manualHint')}</p>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
        {MANUAL.map((k) => <li key={k}>{t(`checklist.manual.${k}`)}</li>)}
      </ul>
    </Card>
  );
}
