import { z } from 'zod';
import { boundedDecimal, isoDateField, noControlChars, optionalText } from './common';

// Day-close input, shared by the counted-cash form and the server actions. Money is text (never a
// float). Messages are `errors.field.*` keys. `post_day_close` is the authority on the expected
// figure, the difference, the period lock and "already closed".

export const closeDaySchema = z.object({
  date: isoDateField,
  /** What is physically in the drawer. Zero is allowed (an empty drawer); negative is not. */
  counted: boundedDecimal(14, 2, 'money_invalid'),
  /**
   * The expected figure the screen showed (can be negative: a drawer the books have overdrawn). The
   * database refuses the close if the ledger has moved since, so a "matches" preview cannot turn into
   * a surprise difference.
   */
  expectedSeen: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'money_invalid'),
  note: optionalText(200),
});

export const reopenDaySchema = z.object({
  id: z.uuid('id_invalid'),
  // Kept in the audit trail beside the reversal.
  reason: z.string().trim().min(3, 'reason_required').max(200, 'text_long').refine(noControlChars, 'text_invalid'),
});

export type CloseDayInput = z.input<typeof closeDaySchema>;
