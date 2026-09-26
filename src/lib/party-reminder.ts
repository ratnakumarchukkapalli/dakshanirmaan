import { whatsappNumber } from '@/lib/phone';

/**
 * The wa.me link for a payment reminder, or null when the party has no usable WhatsApp mobile (only
 * the WhatsApp number counts, never the plain phone: see whatsappNumber). No Business API in v1:
 * the owner's own WhatsApp opens with the message ready. `amount` is the pre-formatted receivable.
 */
export function reminderUrl(whatsapp: string | null | undefined, message: string): string | null {
  const mobile = whatsappNumber(whatsapp);
  return mobile ? `https://wa.me/91${mobile}?text=${encodeURIComponent(message)}` : null;
}
