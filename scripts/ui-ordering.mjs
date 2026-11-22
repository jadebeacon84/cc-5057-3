import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = 'artifacts';
mkdirSync(OUT, { recursive: true });

// Drives the ordering fixture through the real editor UI. It asserts that the
// placement and the route both come from the solver, that a manual move is
// re-verified, and that an illegal click is rejected with a named conflict.
// Run this against `npm run dev` (see README) — it is not a unit test.

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

const ready = async () =>
  page.waitForFunction(() => {
    const t = document.getElementById('status-text')?.textContent ?? '';
    return t && !t.includes('求解');
  }, { timeout: 30000 });
const status = () => page.textContent('#status-text');
const spotRows = () =>
  page.$$eval('.spot-card .kv', (els) => {
    const rows = els[0]?.querySelectorAll('.k, .v') ?? [];
    const out = [];
    for (let i = 0; i < rows.length; i += 2) out.push(`${rows[i].textContent}=${rows[i + 1].textContent}`);
    return out;
  });

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await ready();

// --- Load the ordering fixture through the chrome button.
await page.click('#btn-ordering');
await page.waitForTimeout(2500);
await ready();

const badge = await page.textContent('#scene-badge');
const note = (await page.textContent('#scene-note')) ?? '';
assert.equal(badge, 'Ordering Lab', 'ordering button loads the fixture');
assert.match(note, /hub.*vault.*出口/s, 'scene note describes the fixture');

const initialStatus = await status();
assert.match(initialStatus, /落位成立/, `fixture must solve: ${initialStatus}`);
console.log('1 loaded:', initialStatus);

// --- Route evidence comes from the patched solver (key → key → step → exit).
await page.click('.tab[data-tab="proof"]');
await page.waitForTimeout(300);
const strip = ((await page.textContent('.route-strip')) ?? '').replace(/\s+/g, '');
assert.equal(strip, 'ENTRY→vault-key→hall-key→pass→exit', `route order: ${strip}`);
const legTags = await page.$$eval('.basis-row .tag', (els) => els.map((e) => e.textContent));
const legCount = legTags.filter((t) => /^L\d+$/.test(t)).length;
assert.ok(legCount >= 3, `route has real legs, got ${legCount}`);
console.log('2 route:', strip, `| legs: ${legCount}`);
await page.screenshot({ path: `${OUT}/20-ordering-proof.png` });

// --- Move the task point by clicking the 3D floor; the solver re-runs.
await page.click('.step-card[data-step="pass"] .name');
await page.waitForTimeout(500);
await page.click('.tab[data-tab="spot"]');
await page.waitForTimeout(200);
const before = await spotRows();
assert.match(before.join(' '), /区域=vault/, `seal starts in the vault: ${before.join(' ')}`);
await page.screenshot({ path: `${OUT}/21-ordering-editor.png` });

const box = await (await page.$('#stage')).boundingBox();
await page.mouse.click(box.x + box.width * 0.63, box.y + box.height * 0.57);
await page.waitForTimeout(1600);
await ready();
const after = await spotRows();
assert.notDeepEqual(after, before, `manual click must move the object: ${after.join(' ')}`);
assert.match(after.join(' '), /区域=vault/, `moved seal stays in the vault: ${after.join(' ')}`);
const movedStatus = await status();
assert.match(movedStatus, /落位成立.*含手动调整/, `moved placement is re-verified: ${movedStatus}`);
console.log('3 moved:', after.join(' | '), '|', movedStatus);
await page.screenshot({ path: `${OUT}/22-ordering-move.png` });

// --- An illegal click (hub, but the seal requires vault) must be named.
let hubPoint = null;
for (let gy = 0.3; gy <= 0.75 && !hubPoint; gy += 0.05) {
  for (let gx = 0.08; gx <= 0.5; gx += 0.04) {
    await page.mouse.move(box.x + box.width * gx, box.y + box.height * gy);
    const tip = await page.evaluate(() => {
      const el = document.getElementById('tooltip');
      if (!el || el.classList.contains('hidden')) return null;
      return {
        title: el.querySelector('.t-title')?.textContent ?? '',
        row: el.querySelector('.t-row')?.textContent ?? '',
      };
    });
    if (tip && tip.title === 'Entry Hub') {
      hubPoint = { gx, gy, row: tip.row };
      break;
    }
  }
}
assert.ok(hubPoint, 'found a hub cell to click');
await page.mouse.click(box.x + box.width * hubPoint.gx, box.y + box.height * hubPoint.gy);
await page.waitForTimeout(1600);
await ready();
const rejectedStatus = await status();
assert.match(rejectedStatus, /手动落位被拒绝/, `illegal click rejected: ${rejectedStatus}`);
await page.click('.tab[data-tab="issues"]');
await page.waitForTimeout(300);
const issueCodes = await page.$$eval('.issue-card .code', (els) => els.map((e) => e.textContent));
assert.ok(issueCodes.some((c) => c.includes('MANUAL_CELL_REJECTED')), `named conflict: ${issueCodes.join(', ')}`);
const issueMsgs = await page.$$eval('.issue-card .msg', (els) => els.map((e) => e.textContent));
assert.ok(issueMsgs.some((m) => /hard-requires a “vault” zone/.test(m)), `reason is specific: ${issueMsgs.join(' | ')}`);
await page.screenshot({ path: `${OUT}/23-ordering-reject-issues.png` });
await page.click('.tab[data-tab="spot"]');
await page.waitForTimeout(300);
const kept = await spotRows();
assert.equal(kept.join('|'), after.join('|'), `previous placement is kept for inspection: ${kept.join('|')}`);
console.log('4 rejected:', rejectedStatus, '|', issueCodes.join(' | '));
await page.screenshot({ path: `${OUT}/23-ordering-reject.png` });

// --- Reset restores the pure solver placement; the button toggles back.
await page.click('#btn-reset');
await page.waitForTimeout(1600);
await ready();
const resetStatus = await status();
assert.match(resetStatus, /落位成立/, `reset restores a valid plan: ${resetStatus}`);
assert.doesNotMatch(resetStatus, /含手动调整/, 'reset clears manual overrides');
console.log('5 reset:', resetStatus);

await page.click('#btn-ordering');
await page.waitForTimeout(1800);
await ready();
assert.equal(await page.textContent('#scene-badge'), 'Amber Reach');
console.log('6 back to demo:', await status());
await page.screenshot({ path: `${OUT}/24-ordering-back.png` });

assert.deepEqual(errors, [], `console errors: ${errors.join('\n')}`);
console.log('ERRORS: none');
await browser.close();
