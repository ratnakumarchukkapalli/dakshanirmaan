import { notFound } from 'next/navigation';
import { PaymentForm } from '@/components/payments/PaymentForm';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { compareDecimal, decimalText } from '@/lib/decimal';
import { loadPaymentFormContext } from '@/lib/payments-data';
import type { PaymentFormInitial } from '@/lib/payments-types';
import { createClient } from '@/lib/supabase/server';

/**
 * One screen for the receipt/payment form. `?id=` resumes an existing draft; a fresh visit starts
 * a blank one. There is no separate view route for a posted payment — that mirrors change 11's
 * challan precedent (the frontend spec names only this one route for payments too).
 */
export default async function NewPaymentPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const supabase = await createClient();
  const member = await getCurrentMember();
  const isAdmin = isVerifiedAdmin(member);

  let initial: PaymentFormInitial | undefined;
  let keepPartyId: string | undefined;

  if (id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
    const [{ data: head }, { data: allocs }] = await Promise.all([
      supabase
        .from('payments')
        .select('id, status, updated_at, direction, party_id, payment_date, mode, instrument_no, instrument_date, cheque_bank, amount, discount, account_id, note')
        .eq('id', id).maybeSingle(),
      supabase.from('payment_allocations').select('invoice_type, invoice_id, amount').eq('payment_id', id),
    ]);
    if (!head) notFound();
    // A posted or cancelled payment is only ever seen from the list; there is no draft form to hand it back to.
    if (head.status !== 'draft') notFound();
    keepPartyId = head.party_id;

    initial = {
      id: head.id,
      updatedAt: head.updated_at,
      values: {
        direction: head.direction as 'receipt' | 'payment',
        partyId: head.party_id,
        paymentDate: head.payment_date,
        mode: head.mode as PaymentFormInitial['values']['mode'],
        instrumentNo: head.instrument_no ?? '',
        instrumentDate: head.instrument_date ?? '',
        chequeBank: head.cheque_bank ?? '',
        amount: decimalText(head.amount, 2),
        discount: compareDecimal(decimalText(head.discount, 2), '0.00', 2) === 0 ? '' : decimalText(head.discount, 2),
        accountId: head.account_id,
        note: head.note ?? '',
        allocations: (allocs ?? []).map((a) => ({
          invoiceType: a.invoice_type as 'sales_invoice' | 'purchase_invoice', invoiceId: a.invoice_id as string, amount: decimalText(a.amount, 2),
        })),
      },
    };
  }

  const ctx = await loadPaymentFormContext(supabase, isAdmin, keepPartyId);
  return <PaymentForm ctx={ctx} initial={initial} />;
}
