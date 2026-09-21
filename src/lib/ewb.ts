import { todayIn } from '@/lib/format';

/** Transport and e-way-bill fields as the posted view and its form hold them (all text; blank = not recorded). */
export interface EwbValues {
  vehicleNo: string;
  transporterName: string;
  transportMode: string;
  distanceKm: string;
  transporterGstin: string;
  ewbNo: string;
  ewbDate: string;
  /** ISO date (the day the e-way bill stops being valid). */
  ewbValidUntil: string;
}

/** `ewb_valid_until` is a timestamp; the family thinks of it as a date in India. */
export const validUntilDate = (stamp: string | null): string => (stamp ? todayIn('Asia/Kolkata', new Date(stamp)) : '');
