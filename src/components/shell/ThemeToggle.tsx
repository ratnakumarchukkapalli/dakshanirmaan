'use client';

/** Flips light ↔ dark and remembers it on this device. An explicit choice beats the OS setting. */
export function ThemeToggle({ label }: { label: string }) {
  function toggle() {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme');
    const osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = current ? current === 'dark' : osDark;
    const next = isDark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('dn-theme', next);
    } catch {
      // Private mode or blocked storage: the choice still applies for this page view.
    }
  }
  return (
    <button type="button" className="iconbtn" onClick={toggle} aria-label={label} title={label}>
      <span aria-hidden="true">◐</span>
    </button>
  );
}
