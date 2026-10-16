import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveStageHit } from '../src/stage-rules.js';

const origin = process.env.GAME_URL || 'http://127.0.0.1:5178/';
const artifactDir = 'artifacts/building-damage';
await fs.mkdir(artifactDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const reports = [], errors = [], shotTrace = [];
const hashSources = async () => {
  const files = ['index.html', ...await fs.readdir('src').then(files => files.filter(file => /\.(js|css)$/.test(file)).map(file => `src/${file}`)), 'scripts/building-check.mjs'];
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
};
const beforeHashes = await hashSources();
const state = page => page.evaluate(() => window.__burgerGame.state);
const building = page => page.evaluate(() => window.__burgerGame.building);
const frame = page => page.evaluate(() => {
  const exposed = target => target.x > 14 && target.x < innerWidth - 14 && target.y > 70 && target.y < innerHeight - 90 && document.elementFromPoint(target.x, target.y)?.id === 'gameCanvas';
  return { state: window.__burgerGame.state, building: window.__burgerGame.building, nodes: window.__burgerGame.nodes, setpieces: window.__burgerGame.setpieces, targets: window.__burgerGame.targets.filter(exposed), buildingTargets: window.__burgerGame.buildingTargets.filter(exposed), stats: window.__burgerGame.sceneStats };
});
const settle = page => page.waitForFunction(() => window.__burgerGame.state.projectiles === 0 && window.__burgerGame.state.pendingBursts === 0, null, { timeout: 15000 });
const tap = (locator, touch) => touch ? locator.tap() : locator.click();
const partById = (snapshot, id) => snapshot.parts.find(part => part.id === id);
const isBroken = part => part && part.status !== 'intact';
const snapshotMotion = snapshot => snapshot.parts.map(({ id, status, position }) => ({ id, status, position }));

async function ready(page) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__burgerGame?.state.phase === 'prep' && window.__burgerGame.building?.parts?.length > 0);
  await page.locator('#loading').waitFor({ state: 'detached' });
  if (await page.locator('#prepGuide [data-guide-skip]').isVisible()) await page.locator('#prepGuide [data-guide-skip]').click();
}
async function begin(page, touch) {
  await tap(page.locator('#startButton'), touch);
  await page.waitForFunction(() => window.__burgerGame.state.phase === 'battle');
  if (await page.locator('#gameGuide [data-guide-skip]').isVisible()) await tap(page.locator('#gameGuide [data-guide-skip]'), touch);
  assert.equal((await state(page)).selected, 'corn');
}
async function choose(page, ammo, touch) {
  const button = page.locator(`[data-ingredient="${ammo}"]`);
  await button.scrollIntoViewIfNeeded(); await tap(button, touch);
  assert.equal((await state(page)).selected, ammo);
}
async function clickPoint(page, point, touch) {
  if (touch) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
}
async function shootFood(page, choice, touch) {
  await choose(page, choice.ammo, touch);
  const point = (await frame(page)).targets.find(target => target.id === choice.target.id);
  assert.ok(point, `food ${choice.target.id} remains visible through actual collision geometry`);
  const before = await state(page);
  const trace = { viewport: page.viewportSize(), ammo: choice.ammo, target: point, predicted: choice.outcome, before };
  shotTrace.push(trace);
  await clickPoint(page, point, touch); await settle(page);
  const after = await state(page);
  trace.after = after;
  assert.equal(after.shots, before.shots + 1, 'one actual pointer action creates one shot');
  assert.ok(after.removed > before.removed, 'a legal food shot reaches its target and clears food');
  return { ammo: choice.ammo, targetId: point.id, removed: after.removed - before.removed, objectives: after.objectives, coins: after.coins, phase: after.phase };
}
async function choices(page, mechanism = null) {
  const world = await frame(page), result = [];
  for (const target of world.targets) for (const [ammo, quantity] of Object.entries(world.state.inventory)) {
    if (!quantity || ammo === 'corn') continue;
    const outcome = resolveStageHit({ ammo, target: world.nodes.find(node => node.id === target.id), neighbors: world.nodes, setpieces: world.setpieces });
    if (!outcome.removeIds.length || mechanism && !outcome.setpieceIds.includes(mechanism)) continue;
    result.push({ ammo, target, outcome });
  }
  return result.sort((a, b) => b.outcome.setpieceIds.length - a.outcome.setpieceIds.length || b.outcome.removeIds.length - a.outcome.removeIds.length);
}
async function inspectBounds(page) {
  const viewport = page.viewportSize();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page fits horizontally');
  for (const selector of ['#shopButton', '#backToPrep', '.combat-loadout']) {
    const bounds = await page.locator(selector).boundingBox();
    assert.ok(bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, `${selector} remains inside the viewport`);
  }
}
async function checkDevice(width, height, touch) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: touch ? 1 : 2, hasTouch: touch, isMobile: touch });
  const page = await context.newPage(), device = `${width}x${height}`;
  await ready(page); await begin(page, touch); await inspectBounds(page);
  await page.screenshot({ path: `${artifactDir}/before-${device}.png` });
  const initial = await frame(page);
  assert.ok(initial.building.parts.length >= 5, 'restaurant has distinct destructible structural parts');
  assert.ok(initial.building.parts.every(part => part.status === 'intact' && part.hp === part.maxHp), 'a fresh restaurant starts fully intact');
  // Prefer the central red structure; choosing comes from read-only projections,
  // and the actual click must travel through the same collision path as a player.
  const wall = initial.buildingTargets.find(target => /门柱/.test(target.label)) || initial.buildingTargets.find(target => /红墙/.test(target.label)) || initial.buildingTargets[0];
  assert.ok(wall, 'a real exposed building surface can be aimed at');
  const initialPart = partById(initial.building, wall.id);
  assert.ok(initialPart && initialPart.maxHp > 1);
  await clickPoint(page, wall, touch); await settle(page);
  const cracked = await frame(page), crackedPart = partById(cracked.building, wall.id);
  assert.ok(crackedPart.hp < initialPart.hp, 'direct corn collision reduces structure durability');
  assert.ok(crackedPart.hp > 0 && crackedPart.status === 'intact', 'one corn hit leaves a damaged standing surface');
  assert.ok(crackedPart.crackLevel > initialPart.crackLevel && cracked.building.cracks > initial.building.cracks, 'durability loss creates visible crack geometry on the struck surface');
  assert.equal(cracked.state.removed, initial.state.removed, 'building damage does not count as cleared food');
  assert.equal(cracked.state.coins, initial.state.coins, 'building damage does not mint food rewards');
  assert.equal(cracked.state.earned, initial.state.earned);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${artifactDir}/cracked-${device}.png` });

  const nextPoint = cracked.buildingTargets.find(target => target.id === wall.id);
  assert.ok(nextPoint, 'the cracked part remains collidable');
  let cdp;
  if (touch) {
    cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: nextPoint.x, y: nextPoint.y }] });
  } else { await page.mouse.move(nextPoint.x, nextPoint.y); await page.mouse.down(); }
  try {
    await page.waitForFunction(id => window.__burgerGame.building.parts.some(part => part.id === id && part.status !== 'intact'), wall.id, { timeout: 20000, polling: 35 });
  } finally {
    if (touch) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach(); }
    else await page.mouse.up();
  }
  const fractured = await frame(page);
  assert.ok(isBroken(partById(fractured.building, wall.id)), 'sustained corn fire destroys the selected part');
  assert.equal(partById(fractured.building, wall.id).collidable, false, 'the falling part releases its physical collider');
  assert.ok(fractured.state.shots > cracked.state.shots + 1, 'destruction used multiple real continuous shots');
  assert.equal(fractured.buildingTargets.some(target => target.id === wall.id), false, 'destroyed structure is removed from collision target queries');
  await tap(page.locator('#shopButton'), touch);
  await page.locator('#shopDialog[open]').waitFor();
  const paused = await building(page);
  await page.waitForTimeout(450);
  const stillPaused = await building(page);
  assert.deepEqual(snapshotMotion(stillPaused), snapshotMotion(paused), 'shopping freezes falling structure positions and statuses');
  await tap(page.locator('#shopContinue'), touch);
  await settle(page);
  await page.waitForFunction(id => window.__burgerGame.building.parts.some(part => part.id === id && part.status === 'rubble'), wall.id, { timeout: 12000 });
  const broken = await frame(page);
  await page.screenshot({ path: `${artifactDir}/broken-${device}.png` });

  const links = { bucket: 'left-wing', sauce: 'loft', fries: 'right-wing' }, mechanisms = [];
  for (const [mechanism, zone] of Object.entries(links)) {
    const before = await frame(page);
    if (before.setpieces.find(piece => piece.id === mechanism)?.cleared) continue;
    const choice = (await choices(page, mechanism)).find(choice => choice.ammo === choice.target.ingredient) || (await choices(page, mechanism))[0];
    assert.ok(choice, `${mechanism} has a visible food trigger after structural destruction`);
    const result = await shootFood(page, choice, touch);
    const after = await frame(page), linked = after.building.parts.filter(part => part.zone === zone);
    assert.ok(after.setpieces.find(piece => piece.id === mechanism).cleared, `${mechanism} activates from a real shot`);
    assert.ok(linked.length > 0 && linked.every(isBroken), `${mechanism} collapses its ${zone} building section`);
    mechanisms.push({ mechanism, zone, result, parts: linked });
    await page.screenshot({ path: `${artifactDir}/${mechanism}-${device}.png` });
  }
  const finishShots = [];
  for (let attempt = 0; attempt < 30 && (await state(page)).phase === 'battle'; attempt++) {
    const choice = (await choices(page))[0];
    assert.ok(choice, 'the prepared loadout can reach a remaining legal food target');
    finishShots.push(await shootFood(page, choice, touch));
  }
  const won = await state(page);
  assert.equal(won.phase, 'won', 'actual legal shots complete the round');
  assert.equal(won.objectives, 3);
  assert.equal(won.removed, won.total, 'final cascade clears the remaining food');
  assert.equal(won.coins, 60 + won.earned - won.spent, 'wall attacks and structural collapse preserve the food economy');
  const wonAimLabel = (await page.locator('#aimLabel').textContent()).trim();
  assert.doesNotMatch(wonAimLabel, /换弹|还需|持续射击|长按连发/, 'victory clears the previous active-target aiming instruction');
  const falling = await frame(page);
  assert.ok(falling.building.parts.every(isBroken), 'the final cascade releases every remaining structural part');
  await page.screenshot({ path: `${artifactDir}/finale-${device}.png` });
  await page.locator('#resultDialog[open]').waitFor({ timeout: 15000 });
  const finale = await frame(page);
  assert.ok(finale.building.parts.every(part => part.status === 'rubble'), 'the building finishes falling before the result modal pauses the world');
  assert.equal(finale.buildingTargets.length, 0, 'the collapsed restaurant has no structural colliders');
  assert.ok(finale.building.parts.every(part => part.collidable === false));
  assert.ok(finale.building.debris <= 48, 'structural particle fragments stay bounded');
  assert.ok(finale.stats.drawCalls < 700, 'the completed scene keeps draw calls bounded');
  await page.screenshot({ path: `${artifactDir}/result-${device}.png` });
  await tap(page.locator('#resultDialog [aria-label="关闭战绩"]'), touch);
  await page.screenshot({ path: `${artifactDir}/rubble-${device}.png` });
  await tap(page.locator('#backToPrep'), touch);
  await page.waitForFunction(() => window.__burgerGame.state.phase === 'prep');
  await begin(page, touch);
  const restarted = await frame(page);
  assert.equal(restarted.building.parts.length, initial.building.parts.length);
  assert.ok(restarted.building.parts.every(part => part.status === 'intact' && part.hp === part.maxHp), 'retry restores every wall, wing, roof, and its durability');
  assert.ok(restarted.buildingTargets.length > 0, 'retry restores structural collision');
  assert.equal(restarted.state.removed, 0); assert.equal(restarted.state.earned, 0);
  reports.push({ device, touchEmulation: touch, stageSeed: initial.state.stageSeed, initial: initial.building, firstImpact: { before: initialPart, after: crackedPart, coins: cracked.state.coins, foodCleared: cracked.state.removed }, fractured: fractured.building, shopPaused: snapshotMotion(paused), broken: broken.building, mechanisms, finishShots, won, wonAimLabel, finale: finale.building, sceneStats: finale.stats, restart: restarted.building });
  await context.close();
}
try {
  for (const [width, height, touch] of [[1440, 900, false], [390, 844, true], [360, 640, true], [844, 390, true]]) await checkDevice(width, height, touch);
  assert.deepEqual(errors, [], 'the browser reports no runtime errors');
  const sourceHashes = await hashSources();
  assert.deepEqual(sourceHashes, beforeHashes, 'runtime source remains stable during regression verification');
  const receipt = { checkedAt: new Date().toISOString(), origin, sourceHashes, errors, reports, notes: 'All gameplay uses real mouse or touchscreen actions. Read-only getters select visible targets and measure damage/collapse; no gameplay state is injected. Mobile tests use Chromium touch emulation, not physical handsets.' };
  await fs.writeFile(`${artifactDir}/building-browser-receipt.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ok: true, devices: reports.map(report => report.device), receipt: `${artifactDir}/building-browser-receipt.json` }));
} catch (error) {
  const failureFrames = [];
  for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.screenshot({ path: `${artifactDir}/failure.png` }).catch(() => {});
    failureFrames.push({ viewport: page.viewportSize(), frame: await frame(page).catch(() => null) });
  }
  await fs.writeFile(`${artifactDir}/building-failure.json`, JSON.stringify({ checkedAt: new Date().toISOString(), error: error.stack, errors, reports, shotTrace, failureFrames, beforeHashes, afterHashes: await hashSources() }, null, 2));
  throw error;
} finally { await browser.close(); }
