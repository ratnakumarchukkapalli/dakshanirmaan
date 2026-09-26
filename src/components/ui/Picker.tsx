'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Modal } from './Modal';

export interface PickerOption {
  id: string;
  title: string;
  sub?: string;
  /** Lower-cased text the search box matches against. */
  search: string;
  disabled?: boolean;
}

interface Props {
  id: string;
  options: PickerOption[];
  value: string;
  onPick: (id: string) => void;
  /** What the button shows when nothing is chosen. */
  placeholder: string;
  /** Dialog title, search box label and placeholder, empty text, close label. */
  dialogTitle: string;
  searchLabel: string;
  emptyText: string;
  closeLabel: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  /** Extra content on the button (e.g. a sub-line). */
  buttonExtra?: ReactNode;
  /** Shows the current choice but cannot be changed (e.g. fixed by a delivery challan). */
  disabled?: boolean;
}

/**
 * A big, thumb-friendly chooser for a long list: a button that shows the current choice and opens a
 * dialog with a search box and tall rows. Escape closes it; focus returns to the button. Used
 * inside a `Field`, which supplies the label and the aria wiring.
 */
export function Picker({
  id, options, value, onPick, placeholder, dialogTitle, searchLabel, emptyText, closeLabel, buttonExtra, disabled, ...aria
}: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const chosen = options.find((o) => o.id === value);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter((o) => o.search.includes(needle)) : options;
  }, [options, q]);

  const close = () => {
    setOpen(false);
    setQ('');
  };

  return (
    <>
      <button type="button" id={id} className="pickbtn" aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(true)} {...aria}>
        <span className={chosen ? 'pick-title' : 'pick-title placeholder'}>{chosen ? chosen.title : placeholder}</span>
        {buttonExtra}
        <span className="pick-caret" aria-hidden="true">▾</span>
      </button>
      <Modal open={open} onClose={close} title={dialogTitle} closeLabel={closeLabel}>
        <input
          type="text" role="searchbox" enterKeyHint="search" className="pick-search" aria-label={searchLabel} placeholder={searchLabel} value={q}
          onChange={(e) => setQ(e.target.value)} autoFocus autoComplete="off"
        />
        <ul className="pick-list" role="listbox" aria-label={dialogTitle}>
          {shown.map((o) => (
            <li key={o.id} role="presentation">
              <button
                type="button" role="option" aria-selected={o.id === value} disabled={o.disabled} className="pick-row"
                onClick={() => {
                  onPick(o.id);
                  close();
                }}
              >
                <span className="pick-title">{o.title}</span>
                {o.sub && <span className="pick-sub">{o.sub}</span>}
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="pick-empty">{emptyText}</li>}
        </ul>
      </Modal>
    </>
  );
}
