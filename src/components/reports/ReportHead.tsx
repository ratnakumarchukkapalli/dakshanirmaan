import Link from 'next/link';
import type { ReactNode } from 'react';

interface Props {
  title: string;
  subtitle?: string;
  backLabel: string;
  /** Excel download for the report as filtered on screen. */
  export?: { href: string; label: string };
  children?: ReactNode;
}

/** Title row shared by the report screens: back to the card grid, and the Excel button when the report has one. */
export function ReportHead({ title, subtitle, backLabel, export: exp, children }: Props) {
  return (
    <>
      <Link href="/reports" className="backbtn">← {backLabel}</Link>
      <div className="screenhead">
        <h1>{title}</h1>
        {subtitle && <span className="sub">{subtitle}</span>}
        <span className="headbtns">
          {children}
          {exp && <a className="btn ghost" href={exp.href} download>{exp.label}</a>}
        </span>
      </div>
    </>
  );
}

/** A failed query: always a visible message, never an empty table. */
export function ReportError({ message }: { message: string }) {
  return <p className="alert bad" role="status">{message}</p>;
}
