import { describe, expect, it } from 'vitest';
import { attachmentPath, isAttachmentPath, sniffMime } from './attachments';

const BILL = '11111111-1111-4111-8111-111111111111';

describe('attachment paths', () => {
  it('are built from the bill id and the type, never a file name, and round-trip through the check', () => {
    for (const [mime, ext] of [['image/jpeg', 'jpg'], ['image/png', 'png'], ['application/pdf', 'pdf']] as const) {
      const p = attachmentPath('purchase_invoice', BILL, mime);
      expect(p).toMatch(new RegExp(`^purchase_invoice/${BILL}/[0-9a-f-]{36}\\.${ext}$`));
      expect(isAttachmentPath(p, BILL, mime)).toBe(true);
    }
  });
  it('are refused for another bill, another type, upper case or a traversal', () => {
    const p = attachmentPath('purchase_invoice', BILL, 'image/jpeg');
    expect(isAttachmentPath(p, '22222222-2222-4222-8222-222222222222', 'image/jpeg')).toBe(false);
    expect(isAttachmentPath(p, BILL, 'image/png')).toBe(false);
    expect(isAttachmentPath(p.toUpperCase(), BILL, 'image/jpeg')).toBe(false);
    expect(isAttachmentPath(`${p}/../x`, BILL, 'image/jpeg')).toBe(false);
  });
});

describe('sniffMime', () => {
  it('recognises JPEG, PNG and PDF by their first bytes', () => {
    expect(sniffMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(sniffMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffMime(new TextEncoder().encode('%PDF-1.7\n...'))).toBe('application/pdf');
  });
  it('does not take a web page, an SVG or an empty file for any of them', () => {
    expect(sniffMime(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
  });
});
