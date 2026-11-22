import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'artifacts';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 980 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
const ready = async () =>
  page.waitForFunction(() => {
    const t = document.getElementById('status-text')?.textContent ?? '';
    return t && !t.includes('求解');
  }, { timeout: 30000 });
await ready();

const status = () => page.textContent('#status-text');
console.log('1 initial:', await status());

// --- Select a step from the left rail.
await page.click('.step-card[data-step="cache"] .name');
await page.waitForTimeout(600);
const selectedBasis = await page.textContent('#tab-body');
console.log('2 selected cache, basis has cell?', /对象格/.test(selectedBasis), '| tab:', await page.textContent('.tab.active'));
await page.screenshot({ path: `${OUT}/10-selected-cache.png` });

// --- Manual move: click the 3D ground while the step is selected.
const stage = await page.$('#stage');
const box = await stage.boundingBox();
// Click near the top-right of the stage, on the garden area.
await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.62);
await page.waitForTimeout(1200);
console.log('3 after manual click:', await status());
const afterMove = await page.content();
console.log('   has move conflict or new proof?', /落位|冲突|失败/.test(afterMove));
await page.screenshot({ path: `${OUT}/11-manual-move.png` });

// --- Reload for clean state, then test route playback.
await page.reload({ waitUntil: 'networkidle' });
await ready();
await page.click('.tab[data-tab="proof"]');
await page.waitForTimeout(300);
const before = await page.$$eval('.basis-row', (els) => els.length);
const playBtn = page.locator('button', { hasText: '逐段播放' });
await playBtn.click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/12-route-step1.png` });
const routeState1 = await page.textContent('#status-text');
for (let i = 0; i < 3; i++) {
  await playBtn.click();
  await page.waitForTimeout(250);
}
await page.screenshot({ path: `${OUT}/13-route-step4.png` });
console.log('4 route playback rows:', before, '| status unchanged:', routeState1 === (await status()));

// --- Seed switch.
await page.click('.tab[data-tab="seeds"]');
await page.waitForTimeout(300);
const rows = await page.$$('.seed-table tbody tr');
console.log('5 seed rows:', rows.length);
if (rows.length > 1) {
  await rows[1].click();
  await page.waitForTimeout(1500);
  console.log('   after seed switch:', await status());
  await page.screenshot({ path: `${OUT}/14-seed-switch.png` });
}

// --- Hover tooltip over the stage.
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForTimeout(400);
const tooltipVisible = await page.evaluate(() => !document.getElementById('tooltip')?.classList.contains('hidden'));
console.log('6 tooltip visible on hover:', tooltipVisible);

// --- Toggle invalid and back.
await page.click('#btn-invalid');
await page.waitForTimeout(1500);
console.log('7 invalid status:', await status());
await page.click('.tab[data-tab="basis"]');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/15-invalid-basis.png` });
await page.click('#btn-invalid');
await page.waitForTimeout(1800);
console.log('8 back to valid:', await status());
await page.screenshot({ path: `${OUT}/16-back-valid.png` });

// --- Illegal manual placement is named in the issues tab, reset restores it.
// The seal hard-requires a vault zone, so clicking elsewhere is rejected.
await page.click('.step-card[data-step="seal"] .name');
await page.waitForTimeout(400);
await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.62);
await page.waitForTimeout(1400);
await page.click('.tab[data-tab="issues"]');
await page.waitForTimeout(300);
const manualCodes = await page.$$eval('.issue-card .code', (els) => els.map((e) => e.textContent));
console.log('9 illegal click status:', await status(), '| conflicts:', manualCodes.join(' | '));
await page.screenshot({ path: `${OUT}/17-manual-rejected.png` });
await page.click('#btn-reset');
await page.waitForTimeout(1500);
console.log('10 after reset:', await status());

console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
if (errors.length) process.exitCode = 1;
