import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderToBuffer } from '@react-pdf/renderer';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import type { InvoicePdfData } from './data';
import { registerFonts } from './fonts';
import { invoiceDocument } from './InvoiceDocument';
import { qrDataUrl, upiUri } from './upi';

vi.mock('server-only', () => ({}));

const org: InvoicePdfData['org'] = {
  legalName: 'Daksha Nirmaan Traders', tradeName: 'Daksha Traders', gstin: '37AAPFU0939F1ZV', stateCode: '37',
  address: { line1: 'Plot 9, Main Road', city: 'Guntur', pincode: '522001' }, upiVpa: 'daksha@okhdfc',
  bankDetails: 'HDFC Bank, A/c 50200012345678, IFSC HDFC0001234, Guntur', footer: 'Goods once sold will not be taken back.',
};
const none: InvoicePdfData['transport'] = {
  vehicleNo: null, transporterName: null, transporterGstin: null, mode: null, distanceKm: null, ewbNo: null, ewbDate: null, ewbValidUntil: null,
};
const addr = { label: 'Site', line1: '12 Temple Street', city: 'Tenali', pincode: '522201', state_code: '37' };

function line(no: number, over: Partial<InvoicePdfData['lines'][number]> = {}): InvoicePdfData['lines'][number] {
  return {
    no, name: `UltraTech Cement 50kg (item ${no})`, hsn: '2523', uom: 'bag', qty: '10.000', altQty: null, rate: '360.0000',
    discountPct: '0.00', taxable: '3600.00', gstRate: '18.00', tax: '648.00', amount: '4248.00', ...over,
  };
}

const oneLine: InvoicePdfData = {
  number: 'DN/26-27/0001', date: '2026-09-20', cancelled: false, placeOfSupply: '37', intra: true, org,
  party: { name: 'Ramesh Builders', gstin: '37ABCDE1234F1Z5' }, billing: addr, shipping: addr, transport: none,
  lines: [line(1)],
  totals: { taxable: '3600.00', cgst: '324.00', sgst: '324.00', igst: '0.00', roundOff: '0.00', grand: '4248.00' },
  open: '4248.00',
};
const twelve: InvoicePdfData = {
  ...oneLine, number: 'DN/26-27/0002', placeOfSupply: '36', intra: false,
  transport: { ...none, vehicleNo: 'AP 39 TV 1234', transporterName: 'Sri Sai Transport', mode: 'road', distanceKm: 120, ewbNo: '123456789012', ewbDate: '2026-09-20', ewbValidUntil: '2026-09-22T18:29:00+00:00' },
  lines: Array.from({ length: 45 }, (_, i) => line(i + 1, i % 3 === 0 ? { name: 'TMT Bar Fe500D 12mm', hsn: '7214', uom: 'kg', qty: '1250.000', altQty: '100.000', rate: '64.5000', discountPct: '2.00', taxable: '79012.50', gstRate: '18.00', tax: '14222.25', amount: '93234.75' } : {})),
  totals: { taxable: '900000.00', cgst: '0.00', sgst: '0.00', igst: '162000.00', roundOff: '-0.40', grand: '1061999.60' },
  open: '61999.60',
};
const cancelled: InvoicePdfData = { ...oneLine, number: 'DN/26-27/0003', cancelled: true };
const paid: InvoicePdfData = { ...oneLine, number: 'DN/26-27/0004', open: '0.00' };

async function render(data: InvoicePdfData, withQr = true) {
  registerFonts();
  const qr = withQr && !data.cancelled && data.open !== '0.00' ? await qrDataUrl(upiUri({ vpa: org.upiVpa!, name: org.legalName, amount: data.open, note: data.number })) : null;
  return renderToBuffer(invoiceDocument(data, qr));
}
const pageCount = (buf: Buffer) => (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('invoice PDF', () => {
  it('renders a real PDF for a one-line invoice', async () => {
    const buf = await render(oneLine);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(buf)).toBe(1);
  });
  it('paginates a long invoice', async () => {
    expect(pageCount(await render(twelve))).toBeGreaterThan(1);
  });
  it('renders cancelled and paid variants that differ from the plain one', async () => {
    const [a, b, c] = await Promise.all([render(oneLine), render(cancelled), render(paid)]);
    expect(b.equals(a)).toBe(false);
    expect(c.equals(a)).toBe(false);
  });
  it('writes samples for the visual check when PDF_SAMPLES_DIR is set', async () => {
    const dir = process.env.PDF_SAMPLES_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const [name, d] of Object.entries({ cash: oneLine, long: twelve, cancelled, paid })) writeFileSync(path.join(dir, `${name}.pdf`), await render(d));
  });
});

describe('UPI QR', () => {
  it('builds an encoded upi:// link with two-decimal amount', () => {
    expect(upiUri({ vpa: 'daksha@okhdfc', name: 'Daksha Nirmaan Traders', amount: '4248.00', note: 'DN/26-27/0001' }))
      .toBe('upi://pay?pa=daksha%40okhdfc&pn=Daksha%20Nirmaan%20Traders&am=4248.00&tn=DN%2F26-27%2F0001&cu=INR');
  });
  it('decodes back to exactly the link it was made from', async () => {
    const uri = upiUri({ vpa: 'daksha@okhdfc', name: 'Daksha Nirmaan Traders', amount: '61999.60', note: 'DN/26-27/0002' });
    const url = await qrDataUrl(uri);
    const png = PNG.sync.read(Buffer.from(url.split(',')[1]!, 'base64'));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded?.data).toBe(uri);
  });
});
