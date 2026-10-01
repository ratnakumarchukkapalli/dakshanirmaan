import { NewNoteScreen } from '@/components/notes/NoteScreens';
import { requireOwnerPage } from '@/lib/auth/require';

// Owner-only: the database lets only an owner write a note.
export default async function NewDebitNotePage({ searchParams }: { searchParams: Promise<{ invoice?: string }> }) {
  await requireOwnerPage();
  const { invoice } = await searchParams;
  return <NewNoteScreen kind="debit" invoiceId={invoice} />;
}
