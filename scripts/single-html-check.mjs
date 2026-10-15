import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { SINGLE_HTML_NAME } from './build-single-html.mjs';
import { resolveHit } from '../src/ingredient-rules.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const htmlPath = path.join(root, 'release-single', SINGLE_HTML_NAME);
const html = await fs.readFile(htmlPath);
const artifactDir = path.join(root, 'artifacts');
await fs.mkdir(artifactDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const reports = [];

try {
  for (const [width, height, touch] of [[1440, 900, false], [390, 844, true], [844, 390, true], [360, 640, true]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: touch, hasTouch: touch, deviceScaleFactor: 1, offline: true });
    const page = await context.newPage();
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    const tap = async locator => touch ? locator.tap() : locator.click();
    const state = () => page.evaluate(() => window.__burgerGame.state);
    const start = performance.now();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__burgerGame?.state.phase === 'prep', null, { timeout: 20000 });
    await page.locator('#loading').waitFor({ state: 'detached' });
    const bootMs = Math.round(performance.now() - start);
    assert.equal(await page.title(), '吃我一发麦麦 · ABC 食物餐厅');
    assert.equal(await page.locator('input[type="password"], #mcpToken, #mcpConnect').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await tap(page.locator('#dataButton'));
    await page.locator('#dataDialog[open]').waitFor();
    assert.match(await page.locator('#mcpStatus').textContent(), /离线|快照/);
    await tap(page.locator('#dataDialog [data-close]').last());
    await page.screenshot({ path: path.join(artifactDir, `single-html-prep-${width}x${height}.png`) });
    await tap(page.locator('#startButton'));
    await page.waitForFunction(() => window.__burgerGame.state.phase === 'battle');
    const before = await state();
    const nodes = await page.evaluate(() => window.__burgerGame.nodes);
    const targets = await page.evaluate(() => window.__burgerGame.targets.filter(target => target.x >= 14 && target.x <= innerWidth - 14 && target.y >= 72 && target.y <= innerHeight - 92 && document.elementFromPoint(target.x, target.y)?.id === 'gameCanvas'));
    const choices = [];
    for (const [ammo, count] of Object.entries(before.inventory)) {
      if (!count) continue;
      for (const target of targets) {
        const outcome = resolveHit({ ammo, target: nodes.find(node => node.id === target.id), neighbors: nodes });
        if (outcome.type === 'match') choices.push({ ammo, target, outcome });
      }
    }
    const choice = choices.sort((a, b) => b.outcome.removeIds.length - a.outcome.removeIds.length)[0];
    assert.ok(choice && choice.outcome.removeIds.length >= 2, 'offline game presents a real same-ingredient cluster');
    const ammoButton = page.locator(`[data-ingredient="${choice.ammo}"]`);
    await ammoButton.scrollIntoViewIfNeeded();
    await tap(ammoButton);
    if (touch) await page.touchscreen.tap(choice.target.x, choice.target.y); else await page.mouse.click(choice.target.x, choice.target.y);
    await page.waitForFunction(() => window.__burgerGame.state.projectiles === 0);
    const afterShot = await state();
    assert.equal(afterShot.shots, before.shots + 1);
    assert.ok(afterShot.removed > before.removed);
    assert.ok(afterShot.coins > before.coins);
    await tap(page.locator('#shopButton'));
    await page.locator('#shopDialog[open]').waitFor();
    const buy = page.locator('[data-shop-pack="fries"] [data-buy]');
    assert.equal(await buy.isEnabled(), true);
    await tap(buy);
    const afterBuy = await state();
    assert.equal(afterBuy.coins, afterShot.coins - 10);
    assert.equal(afterBuy.inventory.fry, afterShot.inventory.fry + 6);
    await tap(page.locator('#shopContinue'));
    assert.equal((await state()).shopOpen, false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(artifactDir, `single-html-battle-${width}x${height}.png`) });
    assert.deepEqual(errors, []);
    const externalRequests = requests.filter(url => !url.startsWith('file:') && !url.startsWith('data:') && !url.startsWith('blob:'));
    assert.deepEqual(externalRequests, [], 'single HTML makes no network request while playing and shopping');
    reports.push({ viewport: `${width}x${height}`, input: touch ? 'Chromium touch emulation' : 'desktop mouse', bootMs, shots: afterBuy.shots, removed: afterBuy.removed, coins: afterBuy.coins, publicSnapshot: await page.evaluate(() => Boolean(window.__MAIMAI_PUBLIC_SNAPSHOT__)), networkRequests: externalRequests.length, pageErrors: errors, scene: await page.evaluate(() => window.__burgerGame.sceneStats) });
    await context.close();
  }
  assert.deepEqual(await fs.readFile(htmlPath), html, 'the single HTML stays unchanged throughout all offline device checks');
  const receipt = { checkedAt: new Date().toISOString(), file: SINGLE_HTML_NAME, sha256: createHash('sha256').update(html).digest('hex'), bytes: html.byteLength, transport: 'file://', network: 'browser offline', reports, physicalPhoneVerified: false, platformUploadVerified: false };
  await fs.writeFile(path.join(artifactDir, 'single-html-browser-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} finally { await browser.close(); }
