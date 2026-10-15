import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { INGREDIENTS, PACKS, buildInventory, resolveHit } from '../src/ingredient-rules.js';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [], reports = [];
await fs.mkdir('artifacts', { recursive: true });
async function collectFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? collectFiles(path.join(directory, entry.name)) : path.join(directory, entry.name)));
  return nested.flat();
}
const sourceFiles = [...await collectFiles('src'), ...await collectFiles('server'), ...await collectFiles('public'), 'index.html', 'vite.config.js', 'package.json', 'package-lock.json', 'scripts/economy-check.mjs'].sort();
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
}
const sourcesBefore = await sourceHashes();
const state = page => page.evaluate(() => window.__burgerGame.state);
const nodes = page => page.evaluate(() => window.__burgerGame.nodes);
const activeNodes = async page => (await nodes(page)).filter(node => !node.removed);
const visibleTargets = page => page.evaluate(() => window.__burgerGame.targets.filter(target => target.x >= 14 && target.x <= innerWidth - 14 && target.y >= 72 && target.y <= innerHeight - 92 && document.elementFromPoint(target.x, target.y)?.id === 'gameCanvas'));
async function tapOrClick(locator, touch = false) { if (touch) await locator.tap(); else await locator.click(); }
async function ready(page, touch = false) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5178', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__burgerGame?.state.phase === 'prep', null, { timeout: 15000 });
  await page.locator('#loading').waitFor({ state: 'detached' });
  assert.equal((await state(page)).coins, 60, 'the round starts with sixty game coins');
  const loadout = buildInventory(await page.evaluate(() => window.__burgerGame.selection));
  assert.equal(loadout.spent, 56);
  await tapOrClick(page.locator('#startButton'), touch);
  await page.waitForFunction(() => window.__burgerGame.state.phase === 'battle');
  const initial = await state(page);
  assert.equal(initial.coins, 4, 'starting battle pays for the prepared packs');
  assert.equal(initial.spent, 56);
  assert.equal(initial.earned, 0);
  assert.deepEqual(initial.inventory, loadout.inventory);
  await checkReadout(page);
  return initial;
}
async function checkReadout(page) {
  const snapshot = await state(page), ingredient = INGREDIENTS.find(({ id }) => id === snapshot.selected);
  assert.equal(await page.locator('#weaponName').textContent(), ingredient.name);
  assert.equal(await page.locator('#weaponCount').textContent(), snapshot.inventory[snapshot.selected] ? String(snapshot.inventory[snapshot.selected]).padStart(2, '0') : '空仓');
  assert.equal(await page.locator('#coinCount').textContent(), String(snapshot.coins));
  assert.equal(60 + snapshot.earned - snapshot.spent, snapshot.coins, 'every visible balance reconciles with earned and spent coins');
}
async function candidates(page) {
  const [snapshot, allNodes, targets] = await Promise.all([state(page), nodes(page), visibleTargets(page)]), choices = [];
  for (const [ammo, count] of Object.entries(snapshot.inventory)) {
    if (!count) continue;
    for (const target of targets) choices.push({ ammo, target, outcome: resolveHit({ ammo, target: allNodes.find(node => node.id === target.id), neighbors: allNodes }) });
  }
  return choices.sort((a, b) => b.outcome.removeIds.length - a.outcome.removeIds.length);
}
async function choose(page, ammo, touch) {
  const button = page.locator(`[data-ingredient="${ammo}"]`);
  await button.scrollIntoViewIfNeeded(); await tapOrClick(button, touch);
  assert.equal((await state(page)).selected, ammo);
  await checkReadout(page);
}
async function releaseShot(page, choice, touch) {
  await choose(page, choice.ammo, touch);
  const target = (await visibleTargets(page)).find(item => item.id === choice.target.id);
  assert.ok(target, 'the target is still visible and unobstructed');
  const before = await state(page);
  if (touch) await page.touchscreen.tap(target.x, target.y); else await page.mouse.click(target.x, target.y);
  const fired = await state(page);
  assert.equal(fired.shots, before.shots + 1);
  assert.equal(fired.inventory[choice.ammo], before.inventory[choice.ammo] - 1);
  await checkReadout(page);
  return before;
}
async function finishShot(page, before, ammo) {
  await page.waitForFunction(() => window.__burgerGame.state.projectiles === 0, null, { timeout: 10000 });
  const after = await state(page), removed = after.removed - before.removed;
  assert.equal(after.phase, 'battle', 'economy checks stay inside the active round');
  const comboBonus = ammo !== 'burgerbomb' && after.combos > before.combos ? 3 : 0;
  const earned = removed * 3 + (removed ? comboBonus : 0);
  assert.equal(after.earned - before.earned, earned, 'actual eliminated blocks and recipe bonus determine the reward');
  assert.equal(after.coins - before.coins, earned);
  assert.equal(after.spent, before.spent);
  await checkReadout(page);
  return { ammo, removed, earned, coins: after.coins, shots: after.shots };
}
async function shoot(page, choice, touch = false) { return finishShot(page, await releaseShot(page, choice, touch), choice.ammo); }
async function openShop(page, touch = false) {
  await tapOrClick(page.locator('#shopButton'), touch);
  await page.locator('#shopDialog[open]').waitFor();
  assert.equal((await state(page)).shopOpen, true);
  assert.equal(await page.locator('#shopBalance').textContent(), String((await state(page)).coins));
}
async function closeShop(page, touch = false) {
  await tapOrClick(page.locator('#shopContinue'), touch);
  assert.equal((await state(page)).shopOpen, false);
}
async function purchase(page, id, mode = 'split', touch = false) {
  const pack = PACKS.find(item => item.id === id), row = page.locator(`[data-shop-pack="${id}"]`);
  if (mode === 'whole') await tapOrClick(row.locator('[data-mode="whole"]'), touch);
  const before = await state(page), structure = await nodes(page);
  const buy = row.locator('[data-buy]'); await buy.scrollIntoViewIfNeeded();
  assert.equal(await buy.isEnabled(), true, 'earned balance enables the buy button');
  await tapOrClick(buy, touch);
  const after = await state(page), expected = buildInventory([{ id, mode }]);
  assert.equal(after.coins, before.coins - pack.cost);
  assert.equal(after.spent, before.spent + pack.cost);
  assert.equal(after.earned, before.earned);
  assert.equal(after.shots, before.shots);
  assert.equal(after.removed, before.removed);
  assert.deepEqual(await nodes(page), structure, 'shopping preserves the damaged food building');
  for (const ingredient of INGREDIENTS) assert.equal(after.inventory[ingredient.id], before.inventory[ingredient.id] + expected.inventory[ingredient.id]);
  assert.equal(await page.locator('#shopBalance').textContent(), String(after.coins));
  assert.match(await page.locator('#shopMessage').textContent(), /已装填/);
  await checkReadout(page);
  return { id, mode, before: before.coins, after: after.coins, added: expected.inventory };
}
async function earnUntil(page, minimum, touch = false) {
  const shots = [];
  for (let attempt = 0; (await state(page)).coins < minimum && attempt < 8; attempt++) {
    const choice = (await candidates(page)).find(item => item.ammo !== 'burgerbomb' && item.outcome.removeIds.length > 0);
    assert.ok(choice, 'remaining prepared ammunition can earn enough for the desired pack');
    shots.push(await shoot(page, choice, touch));
  }
  assert.ok((await state(page)).coins >= minimum);
  return shots;
}
async function touchBounds(page, width, height) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal page overflow');
  const result = {};
  for (const selector of ['#shopDialog', '#shopClose', '#shopContinue']) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + .5 && box.y + box.height <= height + .5, `${selector} fits the viewport`);
    if (selector !== '#shopDialog') assert.ok(box.width >= 44 && box.height >= 44, `${selector} has a 44 px touch target`);
    result[selector] = box;
  }
  for (const selector of ['[data-shop-pack="fries"] [data-buy]', '[data-shop-pack="bigmac"] [data-mode="whole"]']) {
    const control = page.locator(selector); await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `${selector} has a 44 px touch target`);
    assert.ok(box.x >= 0 && box.x + box.width <= width + .5, `${selector} stays within the screen width`);
    result[selector] = box;
  }
  return result;
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const initial = await ready(page);
  await page.screenshot({ path: 'artifacts/economy-desktop-ready.png' });
  await openShop(page);
  assert.equal(await page.locator('#shopList [data-buy]:enabled').count(), 0, 'four coins cannot buy a pack');
  const disabled = await state(page);
  await page.waitForTimeout(200);
  assert.deepEqual(await state(page), disabled, 'disabled shopping leaves inventory, funds and targets intact');
  await page.screenshot({ path: 'artifacts/economy-desktop-shop-insufficient.png' });
  await closeShop(page);
  const match = (await candidates(page)).find(choice => choice.outcome.type === 'match' && choice.outcome.removeIds.length >= 2);
  assert.ok(match); const matchReceipt = await shoot(page, match);
  assert.ok(matchReceipt.removed >= 2);
  const combo = (await candidates(page)).find(choice => choice.outcome.type === 'combo' && choice.outcome.removeIds.length >= 2);
  assert.ok(combo); const comboReceipt = await shoot(page, combo);
  assert.equal(comboReceipt.earned, comboReceipt.removed * 3 + 3);
  await openShop(page); const fries = await purchase(page, 'fries');
  await page.screenshot({ path: 'artifacts/economy-desktop-restocked.png' });
  const retained = await state(page); await closeShop(page);
  assert.equal((await state(page)).shots, retained.shots);
  assert.equal((await state(page)).removed, retained.removed);
  const topups = await earnUntil(page, 18);
  await openShop(page); const whole = await purchase(page, 'bigmac', 'whole');
  await page.screenshot({ path: 'artifacts/economy-desktop-whole-burger.png' });
  await closeShop(page);

  const pauseChoice = (await candidates(page)).find(choice => choice.ammo === 'burgerbomb' && choice.outcome.removeIds.length > 0 && choice.outcome.removeIds.length <= 4);
  assert.ok(pauseChoice, 'a bounded whole-burger target is available for the pause check');
  const beforePausedShot = await releaseShot(page, pauseChoice, false);
  await page.keyboard.press('KeyB');
  assert.equal((await state(page)).shopOpen, true, 'B opens the shop during projectile flight');
  const paused = await state(page), pausedNodes = await activeNodes(page), pausedTargets = await visibleTargets(page);
  assert.equal(paused.projectiles, 1, 'the projectile is still in flight when the store opens');
  await page.waitForTimeout(900);
  assert.deepEqual(await state(page), paused, 'open shop pauses projectile, reward and ammunition updates');
  assert.deepEqual(await activeNodes(page), pausedNodes, 'food geometry remains paused');
  // Modal geometry hides the targets from pointer interaction; the underlying
  // projected read-only target list itself stays stable while the scene pauses.
  assert.deepEqual(await visibleTargets(page), pausedTargets);
  await page.keyboard.press('KeyB');
  assert.equal((await state(page)).shopOpen, false, 'B closes the shop');
  const resumed = await finishShot(page, beforePausedShot, pauseChoice.ammo);
  assert.equal((await state(page)).shots, beforePausedShot.shots + 1, 'closing the store resumes exactly the existing shot');
  await page.screenshot({ path: 'artifacts/economy-desktop-resumed.png' });
  reports.push({ device: 'desktop mouse and keyboard', initial, matchReceipt, comboReceipt, fries, topups, whole, pausedShot: resumed, final: await state(page) });
  await page.close();

  for (const [width, height] of [[390, 844], [844, 390], [360, 640]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const p = await context.newPage(); await ready(p, true);
    const shopButton = await p.locator('#shopButton').boundingBox();
    assert.ok(shopButton.width >= 44 && shopButton.height >= 44);
    const earned = await earnUntil(p, 10, true);
    await openShop(p, true); const bounds = await touchBounds(p, width, height);
    const bought = await purchase(p, 'fries', 'split', true);
    await p.screenshot({ path: `artifacts/economy-mobile-shop-${width}x${height}.png` });
    await closeShop(p, true);
    const followup = (await candidates(p)).find(choice => choice.ammo === 'fry' && choice.outcome.removeIds.length > 0) || (await candidates(p)).find(choice => choice.outcome.removeIds.length > 0);
    assert.ok(followup); const continued = await shoot(p, followup, true);
    assert.ok(continued.removed > 0, 'touch play continues after restocking without resetting the round');
    await checkReadout(p);
    const readout = await p.locator('#weaponReadout').boundingBox();
    assert.ok(readout.x >= 0 && readout.x + readout.width <= width + .5 && readout.y >= 0 && readout.y + readout.height <= height + .5, 'gun readout remains legible inside the viewport');
    await p.screenshot({ path: `artifacts/economy-mobile-continued-${width}x${height}.png` });
    reports.push({ device: `touch ${width}x${height}`, earned, bought, continued, bounds, readout, final: await state(p) });
    await context.close();
  }
  assert.deepEqual(errors, []);
  const sourcesAfter = await sourceHashes();
  assert.deepEqual(sourcesAfter, sourcesBefore, 'all client, server and public source hashes stay unchanged during browser verification');
  const receipt = { checkedAt: new Date().toISOString(), sourceHashes: sourcesAfter, errors, reports, notes: 'All purchases, ammunition selections and shots use actual mouse, keyboard or touch UI input. Read-only projected targets and ingredient rules choose aiming candidates; game state is never edited. Mobile verification uses Chromium touch emulation.' };
  await fs.writeFile('artifacts/economy-browser-receipt.json', JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ok: true, devices: reports.map(report => report.device), errors, receipt: 'artifacts/economy-browser-receipt.json' }));
} finally { await browser.close(); }
