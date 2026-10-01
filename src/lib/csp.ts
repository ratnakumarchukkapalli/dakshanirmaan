// Content-Security-Policy builder. The nonce is generated per request in src/proxy.ts;
// Next.js reads it back from the request's CSP header and stamps its own scripts.

export function generateNonce(): string {
  return btoa(crypto.randomUUID());
}

interface CspOptions {
  nonce: string;
  /** e.g. https://<project>.supabase.co or http://127.0.0.1:54321 (local). */
  supabaseUrl?: string;
  isDev: boolean;
}

function supabaseSources(supabaseUrl?: string): string[] {
  if (!supabaseUrl) return [];
  try {
    const url = new URL(supabaseUrl);
    const wsScheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return [url.origin, `${wsScheme}//${url.host}`];
  } catch {
    return [];
  }
}

export function buildCsp({ nonce, supabaseUrl, isDev }: CspOptions): string {
  const directives = [
    `default-src 'self'`,
    // React needs eval in development only (stack reconstruction); never in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? ` 'unsafe-eval'` : ''}`,
    // Tailwind and React inline style attributes; accepted in the security spec.
    `style-src 'self' 'unsafe-inline'`,
    // The Supabase origin is for bill photos: private files, opened only through a short-lived signed address.
    `img-src ${['\'self\'', 'data:', ...supabaseSources(supabaseUrl).slice(0, 1)].join(' ')}`,
    `font-src 'self'`,
    `connect-src ${['\'self\'', ...supabaseSources(supabaseUrl)].join(' ')}`,
    `manifest-src 'self'`,
    `worker-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  // Local Supabase runs over plain http, which this directive would break.
  if (!isDev) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}
