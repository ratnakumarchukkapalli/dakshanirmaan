import { cloneElement, type ReactElement } from 'react';

interface Props {
  id: string;
  label: string;
  hint?: string;
  /** Already-translated message. */
  error?: string;
  className?: string;
  /** The single input/select/textarea; it must carry the same `id`. Field adds the aria wiring to it. */
  children: ReactElement<{ 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
}

/**
 * Label + control + hint/error. The control gets `aria-describedby` (hint and/or error, whichever
 * is on screen) and `aria-invalid` automatically, so a call site cannot forget them.
 */
export function Field({ id, label, hint, error, className = '', children }: Props) {
  const hintId = hint && !error ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-err` : undefined;
  const describedBy = [children.props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hintId && (
        <span id={hintId} className="hint" style={{ margin: 0 }}>
          {hint}
        </span>
      )}
      {errorId && (
        <p id={errorId} className="fielderror">
          {error}
        </p>
      )}
    </div>
  );
}
