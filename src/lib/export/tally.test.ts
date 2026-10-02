import { SaxesParser } from 'saxes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type FakeDb } from '@/test/export-fake';
import { ACCOUNTS, buildDb, entries, owner } from '@/test/tally-fixture';
import { accountGroup } from './tally-model';
import { toScaled } from './decimal';
import { cleanText, foldName, NameRegistry, narrationText, tallyAmount, truncateText, xmlAttr, xmlText } from './tally-xml';

vi.mock('server-only', () => ({}));
let member: { userId: string; role: 'admin' | 'user'; name: string; aal: 'aal1' | 'aal2' } | null = null;
let db: FakeDb;
let clientsOpened = 0;
vi.mock('@/lib/auth/current', () => ({ getCurrentMember: async () => member }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    clientsOpened += 1;
    return fakeSupabase(db);
  },
}));

const counter = { userId: 'u-counter', role: 'user' as const, name: 'Counter', aal: 'aal1' as const };

// ---------------------------------------------------------------------------------------------
// A small parser: the file must be well-formed XML (saxes is strict) and is read back as a tree.
// ---------------------------------------------------------------------------------------------

interface Node { name: string; attrs: Record<string, string>; children: Node[]; text: string }
function parseXml(xml: string): Node {
  const root: Node = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const p = new SaxesParser();
  p.on('error', (e) => { throw e; });
  p.on('opentag', (t) => {
    const n: Node = { name: t.name, attrs: Object.fromEntries(Object.entries(t.attributes).map(([k, v]) => [k, String(v)])), children: [], text: '' };
    stack[stack.length - 1]!.children.push(n);
    stack.push(n);
  });
  p.on('text', (t) => { stack[stack.length - 1]!.text += t; });
  p.on('closetag', () => { stack.pop(); });
  p.write(xml).close();
  return root.children[0]!;
}
const find = (n: Node, name: string): Node[] => [...(n.name === name ? [n] : []), ...n.children.flatMap((c) => find(c, name))];
const child = (n: Node, name: string): Node | undefined => n.children.find((c) => c.name === name);
const childText = (n: Node, name: string) => child(n, name)?.text;

/** The bytes of a response as text, after checking the UTF-16LE byte-order mark. */
async function decode(res: Response): Promise<string> {
  const bytes = Buffer.from(await res.arrayBuffer());
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
  return new TextDecoder('utf-16le').decode(bytes);
}

interface V { number: string; type: string; remoteId: string; date: string; narration: string | undefined; party: string | undefined; lines: { ledger: string; positive: string; amount: string; isParty: boolean }[] }
function vouchers(xml: string): V[] {
  return find(parseXml(xml), 'VOUCHER').map((v) => ({
    number: childText(v, 'VOUCHERNUMBER')!, type: childText(v, 'VOUCHERTYPENAME')!, remoteId: v.attrs.REMOTEID!, date: childText(v, 'DATE')!,
    narration: childText(v, 'NARRATION'), party: childText(v, 'PARTYLEDGERNAME'),
    lines: v.children.filter((c) => c.name === 'ALLLEDGERENTRIES.LIST').map((l) => ({
      ledger: childText(l, 'LEDGERNAME')!, positive: childText(l, 'ISDEEMEDPOSITIVE')!, amount: childText(l, 'AMOUNT')!, isParty: childText(l, 'ISPARTYLEDGER') === 'Yes',
    })),
  }));
}
/** Signed paise of a voucher line, debit positive (Tally writes debits negative). */
const debitPositive = (amount: string) => -toScaled(amount, 2);

async function call(part: string | null, fy: string | null = '2026', company: string | null = null) {
  const { tallyResponse } = await import('./tally-handler');
  return tallyResponse(fy, part, company);
}
const fileOf = async (part: string, company: string | null = null) => {
  const res = await call(part, '2026', company);
  expect(res.status).toBe(200);
  return decode(res);
};

beforeEach(() => {
  member = owner;
  db = buildDb();
  clientsOpened = 0;
});

// ---------------------------------------------------------------------------------------------

describe('text rules', () => {
  it('escapes & < > in text and the quote in attributes', () => {
    expect(xmlText('A & B <c> "d" \'e\'')).toBe('A &amp; B &lt;c&gt; "d" \'e\'');
    expect(xmlAttr('say "hi" & go')).toBe('say &quot;hi&quot; &amp; go');
  });

  it('removes control characters and turns emoji into a space', () => {
    expect(cleanText('a\u0000b\u0001c\u0008d\u000Be\u001Ff￾g\u007Fh')).toBe('abcdefgh');
    expect(cleanText('a\u{1F3D7}b\uD800c')).toBe('a b c');
    expect(cleanText('keep\ttab\nand\rbreaks')).toBe('keep\ttab\nand\rbreaks');
  });

  it('keeps Telugu whole when cutting to length', () => {
    const telugu = 'శ్రీ '.repeat(40);
    const cut = truncateText(telugu, 75);
    expect(cut.length).toBeLessThanOrEqual(75);
    expect(/^\p{M}/u.test(telugu.slice(cut.length))).toBe(false);
    expect(narrationText('x'.repeat(2000))).toHaveLength(500);
  });

  it('folds names the way Tally compares them and never reuses one', () => {
    expect(foldName('Ram-Sons')).toBe(foldName('ram  sons'));
    expect(foldName('A/B')).toBe(foldName('a b'));
    expect(foldName('Ram & Sons')).not.toBe(foldName('Ram and Sons'));
    const r = new NameRegistry(['Profit & Loss A/c']);
    expect(r.assign('Ram Sons')).toBe('Ram Sons');
    expect(r.assign('Ram-Sons')).toBe('Ram-Sons (2)');
    expect(r.assign('RAM SONS')).toBe('RAM SONS (3)');
    expect(r.assign('profit & loss a/c')).toBe('profit & loss a/c (2)');
    expect(r.assign('   ')).toBe('Ledger');
    const long = 'n'.repeat(80);
    const a = r.assign(long);
    const b = r.assign(long);
    expect(a).toHaveLength(75);
    expect(b).toHaveLength(75);
    expect(b.endsWith(' (2)')).toBe(true);
  });

  it('writes amounts with two places, debit negative, credit positive, never -0.00', () => {
    expect(tallyAmount('debit', 1180000n)).toBe('-11800.00');
    expect(tallyAmount('credit', 5n)).toBe('0.05');
    expect(() => tallyAmount('debit', 0n)).toThrow();
  });
});

describe('GET /api/reports/tally.xml — who may download', () => {
  it('403 for a counter user, an owner at aal1 and a signed-out visitor, with no database read', async () => {
    for (const m of [counter, { ...owner, aal: 'aal1' as const }, null]) {
      member = m;
      for (const part of ['masters', 'vouchers', null]) {
        const res = await call(part);
        expect(res.status).toBe(403);
        expect(res.headers.get('content-disposition')).toBeNull();
      }
    }
    expect(db.requests).toHaveLength(0);
    expect(clientsOpened).toBe(0);
  });

  it('400 when part is missing or unknown, and for a year that is not set up; no book is read and nothing is logged', async () => {
    for (const part of [null, '', 'all', 'Masters']) expect((await call(part)).status).toBe(400);
    expect((await call('vouchers', '2030')).status).toBe(400);
    expect(db.requests.some((r) => r.name === 'journal_entries' || r.name === 'log_export')).toBe(false);
  });
});

describe('the headers', () => {
  it('names each file for its part and year, as UTF-16 XML, and logs one audit row each', async () => {
    const m = await call('masters');
    expect(m.headers.get('content-disposition')).toBe('attachment; filename="daksha-tally-masters-FY26-27.xml"');
    expect(m.headers.get('content-type')).toBe('application/xml; charset=utf-16');
    expect(m.headers.get('cache-control')).toContain('no-store');
    await m.arrayBuffer();
    const v = await call('vouchers');
    expect(v.headers.get('content-disposition')).toBe('attachment; filename="daksha-tally-vouchers-FY26-27.xml"');
    await v.arrayBuffer();
    expect(db.requests.filter((r) => r.name === 'log_export')).toHaveLength(2);
  });

  it('500 and no file when the audit row cannot be written', async () => {
    db.rpcs.log_export = () => new Error('boom');
    const res = await call('vouchers');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-disposition')).toBeNull();
  });
});

describe('masters file', () => {
  it('is UTF-16LE with a byte-order mark and the declaration, well-formed, in the research envelope', async () => {
    const xml = await fileOf('masters');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
    const root = parseXml(xml);
    expect(root.name).toBe('ENVELOPE');
    expect(childText(find(root, 'HEADER')[0]!, 'TALLYREQUEST')).toBe('Import Data');
    expect(childText(find(root, 'REQUESTDESC')[0]!, 'REPORTNAME')).toBe('All Masters');
    expect(find(root, 'TALLYMESSAGE')[0]!.attrs['xmlns:UDF']).toBe('TallyUDF');
    expect(find(root, 'SVCURRENTCOMPANY')).toHaveLength(0); // only when ?company= is given
  });

  it('puts the company in only when asked, escaped', async () => {
    const xml = await fileOf('masters', 'Ram & Co <Traders>');
    expect(childText(find(parseXml(xml), 'STATICVARIABLES')[0]!, 'SVCURRENTCOMPANY')).toBe('Ram & Co <Traders>');
    expect(xml).toContain('Ram &amp; Co &lt;Traders&gt;');
  });

  it('has a ledger for every leaf account and every party under the right default group, with no opening balance', async () => {
    const ledgers = find(parseXml(await fileOf('masters')), 'LEDGER').map((l) => ({ name: l.attrs.NAME!, inner: childText(l, 'NAME')!, parent: childText(l, 'PARENT')!, billwise: childText(l, 'ISBILLWISEON'), opening: child(l, 'OPENINGBALANCE') }));
    for (const l of ledgers) {
      expect(l.name).toBe(l.inner);
      expect(l.billwise).toBe('No');
      expect(l.opening).toBeUndefined();
    }
    const parent = (name: string) => ledgers.find((l) => l.name === name)?.parent;
    expect(parent('Bank')).toBe('Bank Accounts');
    expect(parent('Accounts Receivable')).toBe('Sundry Debtors');
    expect(parent('Output CGST')).toBe('Duties & Taxes');
    expect(parent('Capital - Dad')).toBe('Capital Account');
    expect(parent('Sales - Cement')).toBe('Sales Accounts');
    expect(parent('Godown Rent')).toBe('Indirect Expenses');
    expect(parent('Ram & Sons')).toBe('Sundry Debtors');
    expect(parent('Ram Sons (2)')).toBe('Sundry Creditors');
    expect(parent('Profit and Loss brought forward')).toBe('Reserves & Surplus');
    // 8 leaf accounts less Cash (Tally's own), 6 parties, the brought-forward ledger; the group row 'Assets' is not a ledger
    expect(ledgers).toHaveLength(10 - 1 + 7 + 1);
    expect(ledgers.some((l) => l.name === 'Assets')).toBe(false);
    expect(ledgers.some((l) => l.name === 'Cash')).toBe(false);
  });

  it('writes Duties & Taxes escaped, and names with & < > quotes, Telugu and emoji so that they read back', async () => {
    const xml = await fileOf('masters');
    expect(xml).toContain('<PARENT>Duties &amp; Taxes</PARENT>');
    expect(xml).toContain('NAME="Ram &amp; Sons"');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    const names = find(parseXml(xml), 'LEDGER').map((l) => l.attrs.NAME!);
    expect(names).toContain('శ్రీ వెంకటేశ్వర కన్‌స్ట్రక్షన్స్');
    const tough = names.find((n) => n.startsWith('Shop'))!;
    expect(tough.length).toBeLessThanOrEqual(75);
    expect(tough).toContain('<Best> "Q" \'x\' & Co');
    expect(tough).not.toMatch(/[\u{1F3D7}\u0001]/u);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(75);
  });

  it('never repeats a name under Tally folding (Ram-Sons / Ram Sons / a party called cash)', async () => {
    const names = find(parseXml(await fileOf('masters')), 'LEDGER').map((l) => l.attrs.NAME!);
    expect(new Set(names.map(foldName)).size).toBe(names.length);
    expect(names).toContain('Ram-Sons');
    expect(names).toContain('Ram Sons (2)');
    expect(names).toContain('cash (2)'); // "Cash" is Tally's own ledger
  });
});

describe('vouchers file', () => {
  it('is well-formed, in the research envelope, with the opening Journal first and every entry of the year after it', async () => {
    const xml = await fileOf('vouchers');
    const root = parseXml(xml);
    expect(childText(find(root, 'REQUESTDESC')[0]!, 'REPORTNAME')).toBe('Vouchers');
    const list = vouchers(xml);
    expect(list.map((v) => v.number)).toEqual([
      'OPENING', 'DN/26-27/0001', 'RCPT/26-27/0001', 'EXP/26-27/0001', 'JE-7', 'DN/26-27/0002', 'DN/26-27/0002/REV', 'JE-10', 'JE-11', 'DN/26-27/0003', 'DN/26-27/0004',
    ]);
    const v = find(root, 'VOUCHER')[1]!;
    expect(v.attrs).toMatchObject({ VCHTYPE: 'Sales', ACTION: 'Create', OBJVIEW: 'Accounting Voucher View' });
    expect(childText(v, 'DATE')).toBe('20260915');
    expect(childText(v, 'EFFECTIVEDATE')).toBe('20260915');
    expect(childText(v, 'ISINVOICE')).toBe('No');
  });

  it('types each voucher by its source and by whether Cash or Bank is on it', async () => {
    const byNumber = new Map(vouchers(await fileOf('vouchers')).map((v) => [v.number, v.type]));
    expect(Object.fromEntries(byNumber)).toEqual({
      'OPENING': 'Journal', 'DN/26-27/0001': 'Sales', 'RCPT/26-27/0001': 'Receipt', 'EXP/26-27/0001': 'Payment', 'JE-7': 'Contra',
      'DN/26-27/0002': 'Sales', 'DN/26-27/0002/REV': 'Journal', 'JE-10': 'Journal', 'JE-11': 'Journal', 'DN/26-27/0003': 'Sales', 'DN/26-27/0004': 'Sales',
    });
  });

  it('sign rule: a debit is ISDEEMEDPOSITIVE Yes with a negative amount, a credit No with a positive one (Dr party / Cr sales / Cr GST)', async () => {
    const sale = vouchers(await fileOf('vouchers')).find((v) => v.number === 'DN/26-27/0001')!;
    expect(sale.party).toBe('Ram & Sons');
    expect(sale.lines).toEqual([
      { ledger: 'Ram & Sons', positive: 'Yes', amount: '-11800.00', isParty: true },
      { ledger: 'Sales - Cement', positive: 'No', amount: '10000.00', isParty: false },
      { ledger: 'Output CGST', positive: 'No', amount: '900.00', isParty: false },
      { ledger: 'Output SGST', positive: 'No', amount: '900.00', isParty: false },
    ]);
    const receipt = vouchers(await fileOf('vouchers')).find((v) => v.number === 'RCPT/26-27/0001')!;
    expect(receipt.lines.map((l) => [l.ledger, l.positive, l.amount])).toEqual([['Bank', 'Yes', '-5000.00'], ['Ram & Sons', 'No', '5000.00']]);
    expect(receipt.party).toBe('Ram & Sons');
  });

  it('every voucher balances to the paisa, every amount has two places and none is -0.00 or zero', async () => {
    const list = vouchers(await fileOf('vouchers'));
    expect(list.length).toBeGreaterThan(10);
    for (const v of list) {
      expect(v.lines.length).toBeGreaterThanOrEqual(2);
      let total = 0n;
      for (const l of v.lines) {
        expect(l.amount).toMatch(/^-?\d+\.\d\d$/);
        expect(l.amount).not.toMatch(/^-?0\.00$/);
        expect(l.positive).toBe(l.amount.startsWith('-') ? 'Yes' : 'No');
        total += toScaled(l.amount, 2);
      }
      expect(total, v.number).toBe(0n);
    }
  });

  it('REMOTEID is stable per entry id: the same on a second export, unique across the file', async () => {
    const a = vouchers(await fileOf('vouchers')).map((v) => v.remoteId);
    const b = vouchers(await fileOf('vouchers')).map((v) => v.remoteId);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    expect(a[0]).toBe('dn-opening-2026');
    expect(a[1]).toBe('dn-je-e-4');
  });

  it('exports a reversed entry and its reversal, both flagged, the reversal as a Journal with its own number', async () => {
    const list = vouchers(await fileOf('vouchers'));
    const original = list.find((v) => v.number === 'DN/26-27/0002')!;
    const reversal = list.find((v) => v.number === 'DN/26-27/0002/REV')!;
    expect(original.narration).toBe('DN/26-27/0002 [Reversed later] - Sale, later cancelled');
    expect(reversal.narration).toBe('DN/26-27/0002 [Reversal entry] - Reversal of DN/26-27/0002');
    expect(reversal.type).toBe('Journal');
    expect(reversal.party).toBeUndefined();
    // net effect nil
    const net = new Map<string, bigint>();
    for (const v of [original, reversal]) for (const l of v.lines) net.set(l.ledger, (net.get(l.ledger) ?? 0n) + debitPositive(l.amount));
    expect([...net.values()].every((n) => n === 0n)).toBe(true);
  });

  it('puts the document number in the narration, and tidies messy narrations (escaped, controls and emoji out, one line, capped)', async () => {
    const xml = await fileOf('vouchers');
    const list = vouchers(xml);
    expect(list.find((v) => v.number === 'EXP/26-27/0001')!.narration).toBe('EXP/26-27/0001 - Rent for September');
    const messy = list.find((v) => v.number === 'JE-10')!.narration!;
    expect(messy).toBe('Cement "50 kg" & <bags> \'x\' శ్రీ second line tab');
    expect(xml).toContain('Cement "50 kg" &amp; &lt;bags&gt;');
    const long = list.find((v) => v.number === 'JE-11')!.narration!;
    expect(long.length).toBeLessThanOrEqual(500);
    expect(long.length).toBeGreaterThan(490);
  });

  it('well-formed with hostile characters anywhere: a party and a company called with & < > " and a control character', async () => {
    const xml = await fileOf('vouchers', 'Evil <&> "Co"');
    const sale = vouchers(xml).find((v) => v.number === 'DN/26-27/0004')!;
    expect(sale.party).toBe('శ్రీ వెంకటేశ్వర కన్‌స్ట్రక్షన్స్');
    const toughLine = vouchers(xml).find((v) => v.number === 'JE-11')!.lines[0]!.ledger;
    expect(toughLine.startsWith('Shop')).toBe(true);
    expect(toughLine).toContain('<Best> "Q" \'x\' & Co');
  });

  it('the opening voucher carries the balance sheet forward: parties split out, prior profit in one reserves ledger', async () => {
    const opening = vouchers(await fileOf('vouchers'))[0]!;
    expect(opening).toMatchObject({ type: 'Journal', number: 'OPENING', date: '20260401', remoteId: 'dn-opening-2026', narration: 'Opening balances brought forward' });
    const map = Object.fromEntries(opening.lines.map((l) => [l.ledger, `${l.positive}:${l.amount}`]));
    expect(map).toEqual({
      'Ram & Sons': 'Yes:-5700.00', // owes us 6000 on receivables, we owe 300 on payables: one netted line on the party
      'Ravi Kumar': 'Yes:-400.00', // employee advance
      'Cash': 'No:300.00', // 300 in, 200 rent and 400 advance out
      'Capital - Dad': 'No:5300.00',
      'Profit and Loss brought forward': 'No:500.00', // 1000 sales less 200 + 300 costs, from last year
    });
    expect(opening.party).toBeUndefined();
  });

  it('opening + the year equals the app\'s trial balance, per ledger (balance sheet) and as the year\'s movement (profit and loss)', async () => {
    const list = vouchers(await fileOf('vouchers'));
    const total = new Map<string, bigint>();
    for (const v of list) for (const l of v.lines) total.set(l.ledger, (total.get(l.ledger) ?? 0n) + debitPositive(l.amount));
    const tbAt = async (date: string) => {
      const out = new Map<string, bigint>();
      const supa = fakeSupabase(db);
      const res = await supa.rpc('trial_balance_asat', { p_date: date });
      for (const r of (res.data as { name: string; account_type: string; closing: number }[])) out.set(r.name, toScaled(r.closing.toFixed(2), 2));
      return out;
    };
    const end = await tbAt('2027-03-31');
    const before = await tbAt('2026-03-31');
    const typeOf = new Map(ACCOUNTS.map((a) => [a.name, a.type]));
    const partyLedgers = ['Ram & Sons', 'Ram-Sons', 'Ram Sons (2)'];
    const toughLedger = [...total.keys()].find((k) => k.startsWith('Shop'))!;
    const telugu = 'శ్రీ వెంకటేశ్వర కన్‌స్ట్రక్షన్స్';
    const partyLedgerNames = [...partyLedgers, telugu, toughLedger, 'Ravi Kumar'];

    // control accounts: the party ledgers together are receivables + payables + employee advances
    expect(partyLedgerNames.reduce((n, k) => n + (total.get(k) ?? 0n), 0n)).toBe((end.get('Accounts Receivable') ?? 0n) + (end.get('Accounts Payable') ?? 0n) + (end.get('Employee Advances') ?? 0n));
    for (const [name, type] of typeOf) {
      if (['Assets', 'Accounts Receivable', 'Accounts Payable', 'Employee Advances'].includes(name)) continue;
      const got = total.get(name) ?? 0n;
      const wantEnd = end.get(name) ?? 0n;
      const wantBefore = before.get(name) ?? 0n;
      if (type === 'income' || type === 'expense') expect(got, name).toBe(wantEnd - wantBefore);
      else expect(got, name).toBe(wantEnd);
    }
    // the reserves ledger is last year's profit; with it every ledger of the file nets to the trial balance
    expect(total.get('Profit and Loss brought forward')).toBe(-500n * 100n);
    expect([...total.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
  });
});

describe('the first year (the go-live opening entry is inside the year)', () => {
  it('adds no synthetic opening voucher: the opening entry is an ordinary Journal and nothing is counted twice', async () => {
    db = buildDb([
      { no: 1, date: '2026-04-01', source: 'opening', sourceId: null, doc: null, narration: 'Go-live', lines: [['a-ar', '5000.00', '0.00', 'p1'], ['a-cash', '300.00', '0.00'], ['a-cap', '0.00', '5300.00']] },
      { no: 2, date: '2026-04-05', source: 'sales_invoice', sourceId: 'inv-1', doc: 'DN/26-27/0001', narration: 'Sale', lines: [['a-ar', '118.00', '0.00', 'p1'], ['a-sales', '0.00', '100.00'], ['a-ocgst', '0.00', '9.00'], ['a-osgst', '0.00', '9.00']] },
    ]);
    const list = vouchers(await fileOf('vouchers'));
    expect(list.map((v) => v.number)).toEqual(['JE-1', 'DN/26-27/0001']);
    expect(list[0]!.type).toBe('Journal'); // cash and bank balances at go-live: still a Journal
    expect(list.some((v) => v.number === 'OPENING')).toBe(false);
    const total = new Map<string, bigint>();
    for (const v of list) for (const l of v.lines) total.set(l.ledger, (total.get(l.ledger) ?? 0n) + debitPositive(l.amount));
    expect(total.get('Ram & Sons')).toBe(5118n * 100n);
    expect(total.get('Cash')).toBe(300n * 100n);
  });

  it('a year with no entries at all is a valid, empty file', async () => {
    db = buildDb([]);
    const xml = await fileOf('vouchers');
    expect(vouchers(xml)).toEqual([]);
    expect(parseXml(xml).name).toBe('ENVELOPE');
  });
});

describe('guards', () => {
  it('an entry that does not balance aborts the export with a message naming it: 422, no file, no audit row', async () => {
    const tampered = entries();
    tampered[5]!.lines[1] = ['a-cash', '0.00', '499.99']; // EXP/26-27/0001: 500.00 vs 499.99
    db = buildDb(tampered);
    for (const part of ['masters', 'vouchers']) {
      const res = await call(part);
      expect(res.status).toBe(422);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(res.headers.get('content-disposition')).toBeNull();
      const body = await res.text();
      expect(body).toContain('EXP/26-27/0001');
      expect(body).toContain('entry 6');
      expect(body).toContain('500.00');
      expect(body).toContain('499.99');
    }
    expect(db.requests.some((r) => r.name === 'log_export')).toBe(false);
  });

  it('an entry with a single line cannot be a voucher: 422', async () => {
    const bad = entries();
    bad[4]!.lines = [['a-bank', '5000.00', '0.00']];
    db = buildDb(bad);
    expect((await call('vouchers')).status).toBe(422);
  });

  it('a trial balance that does not balance before the year stops the opening voucher: 422 naming the gap', async () => {
    const original = db.rpcs.trial_balance_asat!;
    db.rpcs.trial_balance_asat = (args) => {
      const rows = original(args) as { code: string; closing: number }[];
      return String(args?.p_date) === '2026-03-31' ? rows.map((r) => (r.code === '1110' ? { ...r, closing: r.closing + 0.01 } : r)) : rows;
    };
    const res = await call('vouchers');
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('0.01');
  });

  it('500 (and no file) when the database fails; the message never carries the database text', async () => {
    db.errors.journal_entries = 'relation secret_table does not exist';
    const res = await call('vouchers');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret_table');
  });

  it('only posted entries are exported', async () => {
    const list = entries();
    list.push({ no: 16, date: '2026-10-05', source: 'manual', sourceId: null, doc: null, narration: 'draft-ish', status: 'draft', lines: [['a-rent', '1.00', '0.00'], ['a-cap', '0.00', '1.00']] });
    db = buildDb(list);
    const numbers = vouchers(await fileOf('vouchers')).map((v) => v.number);
    expect(numbers).not.toContain('JE-16');
  });
});

describe('review fixes', () => {
  it('Inventory and Goods in Transit are Current Assets, not Stock-in-Hand (Tally may refuse Stock-in-Hand ledgers in plain vouchers)', () => {
    expect(accountGroup({ code: '1300', type: 'asset', system_key: 'inventory' })).toBe('Current Assets');
    expect(accountGroup({ code: '1310', type: 'asset', system_key: 'goods_in_transit' })).toBe('Current Assets');
    expect(Object.values({ a: accountGroup({ code: '1300', type: 'asset', system_key: 'inventory' }) })).not.toContain('Stock-in-Hand');
  });

  it('a party or account named like one of Tally\'s default groups is renamed, not left to clash with the group', async () => {
    (db.tables.parties as Record<string, unknown>[]).push({ ...(db.tables.parties![0] as object), id: 'p8', name: 'Capital Account', created_at: '2026-02-01T00:00:00Z' });
    (db.tables.parties as Record<string, unknown>[]).push({ ...(db.tables.parties![0] as object), id: 'p9', name: 'sundry debtors', created_at: '2026-02-02T00:00:00Z' });
    const names = find(parseXml(await fileOf('masters')), 'LEDGER').map((l) => l.attrs.NAME!);
    expect(names).toContain('Capital Account (2)');
    expect(names).toContain('sundry debtors (2)');
    expect(names).not.toContain('Capital Account');
  });

  it('the opening voucher has one line per ledger: a party with a receivable and a payable opens with the net, an employee with the advance', async () => {
    const opening = vouchers(await fileOf('vouchers'))[0]!;
    const ledgers = opening.lines.map((l) => l.ledger);
    expect(new Set(ledgers).size).toBe(ledgers.length);
    expect(opening.lines.find((l) => l.ledger === 'Ram & Sons')).toMatchObject({ positive: 'Yes', amount: '-5700.00' });
    expect(opening.lines.find((l) => l.ledger === 'Ravi Kumar')).toMatchObject({ positive: 'Yes', amount: '-400.00' });
    expect(ledgers).not.toContain('Accounts Payable'); // the payable is on the party, not left on the control account
    expect(opening.lines.reduce((n, l) => n + toScaled(l.amount, 2), 0n)).toBe(0n);
  });

  it('a reversal in this year of an entry from last year is flagged as a reversal, typed Journal, and the opening voucher still balances', async () => {
    db = buildDb([
      { no: 1, date: '2026-03-20', source: 'sales_invoice', sourceId: 'old-inv', doc: 'DN/25-26/0009', narration: 'Sale last March', reversedBy: 'e-2', lines: [['a-ar', '236.00', '0.00', 'p1'], ['a-sales', '0.00', '200.00'], ['a-ocgst', '0.00', '18.00'], ['a-osgst', '0.00', '18.00']] },
      { no: 2, date: '2026-04-10', source: 'sales_invoice', sourceId: 'old-inv', doc: 'DN/25-26/0009', narration: 'Cancelled', lines: [['a-sales', '200.00', '0.00'], ['a-ocgst', '18.00', '0.00'], ['a-osgst', '18.00', '0.00'], ['a-ar', '0.00', '236.00', 'p1']] },
    ]);
    const list = vouchers(await fileOf('vouchers'));
    expect(list.map((v) => [v.number, v.type])).toEqual([['OPENING', 'Journal'], ['DN/25-26/0009/REV', 'Journal']]);
    expect(list[1]!.narration).toBe('DN/25-26/0009 [Reversal entry] - Cancelled');
    expect(list[1]!.party).toBeUndefined();
    const opening = Object.fromEntries(list[0]!.lines.map((l) => [l.ledger, `${l.positive}:${l.amount}`]));
    expect(opening).toEqual({
      'Ram & Sons': 'Yes:-236.00', 'Output CGST': 'No:18.00', 'Output SGST': 'No:18.00', 'Profit and Loss brought forward': 'No:200.00',
    });
    const net = new Map<string, bigint>();
    for (const v of list) for (const l of v.lines) net.set(l.ledger, (net.get(l.ledger) ?? 0n) + debitPositive(l.amount));
    expect(net.get('Ram & Sons')).toBe(0n); // cancelled in April: the party owes nothing
    expect(net.get('Output CGST')).toBe(0n);
    expect([...net.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
  });
});

describe('the self-check against the trial balance', () => {
  const wrongAtYearEnd = () => {
    const real = db.rpcs.trial_balance_asat!;
    db.rpcs.trial_balance_asat = (args) => {
      const rows = real(args) as { code: string; closing: number }[];
      return String(args?.p_date) === '2027-03-31' ? rows.map((r) => (r.code === '4100' ? { ...r, closing: r.closing - 0.01 } : r)) : rows;
    };
  };

  it('refuses the Tally files (422, no file, no audit row), naming the account, when the vouchers do not add up to the trial balance', async () => {
    wrongAtYearEnd();
    for (const part of ['masters', 'vouchers']) {
      const res = await call(part);
      expect(res.status).toBe(422);
      const body = await res.text();
      expect(body).toContain('Account 4100 Sales - Cement');
      expect(body).toContain('Nothing was exported');
    }
    expect(db.requests.some((r) => r.name === 'log_export')).toBe(false);
  });

  it('passes on honest books (every fixture year above) and also checks a year with entries but no carried-forward balance', async () => {
    expect((await call('vouchers')).status).toBe(200);
    db = buildDb([{ no: 1, date: '2026-04-05', source: 'sales_invoice', sourceId: 'x', doc: 'DN/26-27/0001', narration: 'Sale', lines: [['a-ar', '118.00', '0.00', 'p1'], ['a-sales', '0.00', '100.00'], ['a-ocgst', '0.00', '9.00'], ['a-osgst', '0.00', '9.00']] }]);
    expect((await call('vouchers')).status).toBe(200);
  });

  it('catches an entry that the trial balance has but the vouchers do not (posted while exporting)', async () => {
    const real = db.rpcs.trial_balance_asat!;
    db.rpcs.trial_balance_asat = (args) => {
      const rows = real(args) as { account_id: string; code: string; name: string; account_type: string; total_debit: number; total_credit: number; closing: number }[];
      return String(args?.p_date) === '2027-03-31' ? [...rows.filter((r) => r.code !== '5400'), { account_id: 'a-rent', code: '5400', name: 'Godown Rent', account_type: 'expense', total_debit: 0, total_credit: 0, closing: (rows.find((r) => r.code === '5400')?.closing ?? 0) + 5 }] : rows;
    };
    const res = await call('vouchers');
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Account 5400 Godown Rent');
  });
});
