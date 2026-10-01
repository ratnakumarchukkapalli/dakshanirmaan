import { NoteView } from '@/components/notes/NoteView';

// Anyone signed in can read a posted credit note (it is sales data, like an invoice); only an owner sees the Cancel button.
export default async function CreditNoteViewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string }> }) {
  const [{ id }, { done }] = await Promise.all([params, searchParams]);
  return <NoteView kind="credit" id={id} done={done} />;
}
