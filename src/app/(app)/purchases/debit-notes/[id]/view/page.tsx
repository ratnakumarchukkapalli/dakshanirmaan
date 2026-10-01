import { NoteView } from '@/components/notes/NoteView';
import { requireOwnerPage } from '@/lib/auth/require';

export default async function DebitNoteViewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string }> }) {
  await requireOwnerPage();
  const [{ id }, { done }] = await Promise.all([params, searchParams]);
  return <NoteView kind="debit" id={id} done={done} />;
}
