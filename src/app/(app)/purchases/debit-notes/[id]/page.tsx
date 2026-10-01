import { DraftNoteScreen } from '@/components/notes/NoteScreens';
import { requireOwnerPage } from '@/lib/auth/require';

export default async function DraftDebitNotePage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwnerPage();
  const { id } = await params;
  return <DraftNoteScreen kind="debit" id={id} />;
}
