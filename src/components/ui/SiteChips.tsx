import Link from 'next/link';
import { Chip } from '@/components/ui/Chip';

interface Props {
  label: string;
  sites: { id: string; label: string; isBilling: boolean; isDefault: boolean }[];
  billingText: string;
  defaultText: string;
  manageText: string;
}

/** A party's delivery sites as chips (text, not colour alone), with a link down to the panel that edits them. */
export function SiteChips({ label, sites, billingText, defaultText, manageText }: Props) {
  return (
    <div className="sitechips">
      <span className="lbl">{label}</span>
      {sites.map((s) => (
        <Chip key={s.id} tone="accent">
          {s.label}
          {s.isBilling ? ` · ${billingText}` : s.isDefault ? ` · ${defaultText}` : ''}
        </Chip>
      ))}
      <Link href="#sites" className="backbtn">{manageText}</Link>
    </div>
  );
}
