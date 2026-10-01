import { NewNoteScreen } from '@/components/notes/NoteScreens';
import { requireOwnerPage } from '@/lib/auth/require';

// Owner-only: the database lets only an owner write a note.
export default async function NewCreditNotePage({ searchParams }: { searchParams: Promise<{ invoice?: string }> }) {
  await requireOwnerPage();
  const { invoice } = await searchParams;
  return <NewNoteScreen kind="credit" invoiceId={invoice} />;
}
