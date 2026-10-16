import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const origin = 'http://127.0.0.1:5178/';
const sourceFiles = ['src/main.js', 'src/display-resolution.js'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
const sourceBefore = await sourceHashes();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const checks = [], errors = [];

async function ready(page) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__burgerGame), null, { timeout: 15000 });
}

async function check(page, name, { width, height, dpr }) {
  const ratio = Math.min(dpr, width < 700 ? 1.5 : 2);
  await page.waitForFunction(({ width, height, dpr, ratio }) => {
    const canvas = document.getElementById('gameCanvas');
    return innerWidth === width && innerHeight === height && Math.abs(devicePixelRatio - dpr) < .001
      && canvas.width === Math.floor(width * ratio) && canvas.height === Math.floor(height * ratio);
  }, { width, height, dpr, ratio }, { timeout: 5000 });
  const actual = await page.evaluate(() => {
    const canvas = document.getElementById('gameCanvas'), bounds = canvas.getBoundingClientRect();
    return { dpr: devicePixelRatio, viewport: [innerWidth, innerHeight], buffer: [canvas.width, canvas.height], css: [bounds.width, bounds.height], filter: getComputedStyle(canvas).filter, phase: window.__burgerGame.state.phase };
  });
  assert.deepEqual(actual.css, [width, height], 'display density preserves the CSS viewport');
  assert.equal(actual.filter, 'none', 'the game canvas remains unfiltered');
  checks.push({ name, targetRatio: ratio, ...actual });
}

try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await ready(page);
  await page.locator('#startButton').click();
  await page.waitForFunction(() => window.__burgerGame.state.phase === 'battle');
  const runState = () => page.evaluate(() => {
    const { phase, inventory, coins, shots, stageSeed } = window.__burgerGame.state;
    return { phase, inventory, coins, shots, stageSeed };
  });
  const startedState = await runState();
  const session = await context.newCDPSession(page);
  await check(page, 'initial DPR 1', { width: 1200, height: 800, dpr: 1 });
  for (const [name, width, height, dpr] of [
    ['same viewport DPR 2', 1200, 800, 2],
    ['same viewport DPR 1.25', 1200, 800, 1.25],
    ['portrait density budget', 390, 844, 3],
    ['mobile breakpoint below', 699, 800, 3],
    ['desktop breakpoint at', 700, 800, 3],
    ['restored desktop Retina', 1200, 800, 2],
  ]) {
    await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
    await check(page, name, { width, height, dpr });
    assert.deepEqual(await runState(), startedState, 'density and size changes preserve the current game');
  }
  await context.close();
  const retina = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  const retinaPage = await retina.newPage();
  await ready(retinaPage);
  await check(retinaPage, 'initial Retina load', { width: 1200, height: 800, dpr: 2 });
  await retina.close();
  assert.deepEqual(errors, [], 'display changes produce no page errors');
  assert.deepEqual(await sourceHashes(), sourceBefore, 'verified sources stayed unchanged during the check');
  const receipt = { checkedAt: new Date().toISOString(), origin, input: 'Chromium device-density and viewport emulation', checks, pageErrors: errors, sourceHashes: sourceBefore };
  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile('artifacts/render-resolution-check.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
}
