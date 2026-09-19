export const locales = ['en', 'te'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';
export const LOCALE_COOKIE = 'dn-locale';

export function isLocale(value: string | undefined): value is Locale {
  return (locales as readonly string[]).includes(value ?? '');
}
