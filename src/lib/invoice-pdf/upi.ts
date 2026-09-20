import 'server-only';
import QRCode from 'qrcode';

/** `upi://pay` deep link. Every value is percent-encoded; the amount keeps exactly two decimals. */
export function upiUri({ vpa, name, amount, note }: { vpa: string; name: string; amount: string; note: string }): string {
  const enc = encodeURIComponent;
  return `upi://pay?pa=${enc(vpa)}&pn=${enc(name)}&am=${enc(amount)}&tn=${enc(note)}&cu=INR`;
}

/** The QR as a PNG data URL, drawn on a white ground with a quiet zone so phone cameras read it off paper. */
export function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 320, color: { dark: '#000000', light: '#ffffff' } });
}
