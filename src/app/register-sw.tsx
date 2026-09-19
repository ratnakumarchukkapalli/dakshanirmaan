'use client';

import { useEffect } from 'react';

/** Registers the shell-caching service worker in production builds only. */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Not fatal: the app works online without it.
    });
  }, []);
  return null;
}
