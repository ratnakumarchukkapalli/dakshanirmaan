import { CutoverManager } from '@/components/settings/CutoverManager';
import { loadCutover } from '@/lib/cutover-data';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

export default async function CutoverPage() {
  const [ctx, supabase] = await Promise.all([getShellContext(), createClient()]);
  const data = await loadCutover(supabase, ctx.timeZone);
  return <CutoverManager data={data} />;
}
