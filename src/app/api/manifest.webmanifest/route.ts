// Web app manifest. Colours mirror the light-theme tokens (--bg); a manifest cannot read CSS variables.
export function GET() {
  const manifest = {
    name: 'Daksha Nirmaan Traders',
    short_name: 'Daksha Nirmaan',
    description: 'Accounts and stock for Daksha Nirmaan Traders',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#E9EDF2',
    theme_color: '#E9EDF2',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' },
  });
}
