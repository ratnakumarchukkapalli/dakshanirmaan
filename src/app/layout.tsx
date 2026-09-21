import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import { RegisterServiceWorker } from './register-sw';
import './globals.css';

export const metadata: Metadata = {
  title: 'Daksha Nirmaan Traders',
  description: 'Accounts and stock for Daksha Nirmaan Traders',
  manifest: '/api/manifest.webmanifest',
  icons: { icon: '/icons/icon-192.png', apple: '/icons/maskable-512.png' },
  appleWebApp: { capable: true, title: 'Daksha Nirmaan', statusBarStyle: 'default' },
};

// Browser chrome colours mirror --bg (light) and --bg (dark); meta tags cannot read CSS variables.
export const viewport: Viewport = {
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#E9EDF2' },
    { media: '(prefers-color-scheme: dark)', color: '#0E1116' },
  ],
};

// Applies the saved theme before first paint so there is no light→dark flash.
const THEME_SCRIPT = `try{var t=localStorage.getItem('dn-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, nonce] = await Promise.all([getLocale(), headers().then((h) => h.get('x-nonce') ?? undefined)]);
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <div className="ambient" aria-hidden="true">
          <i className="a" />
          <i className="b" />
          <i className="c" />
        </div>
        <NextIntlClientProvider>
          {children}
          <RegisterServiceWorker />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
