// One real browser visit to the sign-in page: it must render its form and raise no console error or
// page error. CI installs Playwright on the fly (`npm i --no-save playwright`); it is not a project
// dependency, which is why this file is plain JavaScript (the type-check does not know Playwright).
//   node scripts/smoke-browser.mjs [http://localhost:3000]
import { chromium } from 'playwright';

const base = (process.argv[2] ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const browser = await chromium.launch();
const problems = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  const res = await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  if (res?.status() !== 200) problems.push(`/login returned ${res?.status()}`);
  if ((await page.getByRole('button', { name: 'Send code' }).count()) === 0) problems.push('the "Send code" button did not render');
  if ((await page.getByLabel('Email').count()) === 0) problems.push('the Email field did not render');
  // Signed-out /reports must land on the sign-in page.
  await page.goto(`${base}/reports`, { waitUntil: 'networkidle' });
  if (!page.url().includes('/login')) problems.push(`/reports stayed on ${page.url()} for a signed-out visitor`);
} finally {
  await browser.close();
}
if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  process.exit(1);
}
console.log('smoke-browser: sign-in page rendered with no console or page error');
