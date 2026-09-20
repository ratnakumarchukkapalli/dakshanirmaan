'use client';

import { useSyncExternalStore } from 'react';

const isDark = () => {
  const explicit = document.documentElement.getAttribute('data-theme');
  return explicit ? explicit === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
};

/** Re-renders when the theme attribute changes or the OS colour scheme flips. */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener('change', onChange);
  };
}

/** Flips light ↔ dark and remembers it on this device. An explicit choice beats the OS setting. */
export function ThemeToggle({ label }: { label: string }) {
  // Pressed = dark is on. The server cannot know, so it renders "not pressed" and the browser corrects it.
  const dark = useSyncExternalStore(subscribe, isDark, () => false);
  function toggle() {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('dn-theme', next);
    } catch {
      // Private mode or blocked storage: the choice still applies for this page view.
    }
  }
  return (
    <button type="button" className="iconbtn" onClick={toggle} aria-label={label} aria-pressed={dark} title={label}>
      <span aria-hidden="true">◐</span>
    </button>
  );
}
