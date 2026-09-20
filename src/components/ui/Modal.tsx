'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  children: ReactNode;
}

/**
 * Glass dialog built on the native <dialog> element: focus is trapped inside, Escape closes it,
 * and focus returns to whatever opened it. Content is mounted only while open, so forms reset.
 */
export function Modal({ open, onClose, title, closeLabel, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal glass glass-strong"
      aria-labelledby={titleId}
      onClose={onClose}
      // A click on the dialog itself (not its content) is a click on the dimmed backdrop.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="modal-body">
          <div className="modal-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="iconbtn" onClick={onClose} aria-label={closeLabel}>
              <span aria-hidden="true">✕</span>
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
