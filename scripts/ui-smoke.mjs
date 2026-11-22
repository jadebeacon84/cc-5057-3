import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'artifacts';
mkdirSync(OUT, { recursive: true });

// Environment overrides keep this runnable on machines whose system Chromium
// is missing or lacks shared libraries; the repo bundles an extracted sysroot.
const launch = { args: ['--no-sandbox', '--disable-gpu'] };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1600, height: 980 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);

// Wait for the solver to report.
await page.waitForFunction(() => {
  const t = document.getElementById('status-text')?.textContent ?? '';
  return t.includes('落位成立') || t.includes('未成立') || t.includes('失败');
}, { timeout: 30000 });

const status = await page.textContent('#status-text');
const metrics = await page.textContent('#status-metrics');
console.log('STATUS:', status);
console.log('METRICS:', metrics);

const shots = [];
async function shot(name) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path });
  shots.push(path);
  return path;
}

await shot('01-overview');

// Tabs.
for (const [tab, name] of [
  ['proof', '02-proof'],
  ['basis', '03-basis'],
  ['issues', '04-issues'],
  ['seeds', '05-seeds'],
  ['spot', '06-spot'],
]) {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.waitForTimeout(350);
  await shot(name);
  const text = await page.textContent('#tab-body');
  console.log(`TAB ${tab}: ${text.replace(/\s+/g, ' ').slice(0, 140)}`);
}

// Select a step and inspect basis.
await page.click('.step-card .name');
await page.waitForTimeout(500);
const basisText = await page.textContent('#tab-body');
console.log('BASIS after select:', basisText.replace(/\s+/g, ' ').slice(0, 300));
await shot('07-basis-selected');

// Invalid scene.
await page.click('#btn-invalid');
await page.waitForFunction(() => {
  const t = document.getElementById('status-text')?.textContent ?? '';
  return t.includes('未成立');
}, { timeout: 30000 });
await page.click('.tab[data-tab="issues"]');
await page.waitForTimeout(400);
const issueText = await page.textContent('#tab-body');
console.log('INVALID ISSUES:', issueText.replace(/\s+/g, ' ').slice(0, 600));
await shot('08-invalid-issues');

const issueCodes = await page.$$eval('.issue-card .code', (els) => els.map((e) => e.textContent));
console.log('ISSUE CODES:', issueCodes.join(' | '));

await page.click('.tab[data-tab="spot"]');
await page.waitForTimeout(300);
await shot('09-invalid-spot');

console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
console.log('SHOTS:', shots.join(', '));
await browser.close();
if (errors.length) process.exitCode = 1;
