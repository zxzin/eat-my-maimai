import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildInventory, CORN_HITS_TO_CLEAR } from '../src/ingredient-rules.js';
import { STARTER_CORN, CORN_REFILL_COST, CORN_REFILL_AMOUNT } from '../src/economy.js';
import { resolveStageHit } from '../src/stage-rules.js';

const origin = process.env.GAME_URL || 'http://127.0.0.1:5178';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [], reports = [];
const artifactDir = 'artifacts/corn-fire';
await fs.mkdir(artifactDir, { recursive: true });
const sourceFiles = ['index.html', 'src/style.css', 'src/main.js', 'src/ingredient-rules.js', 'src/ingredient-models.js', 'src/economy.js', 'src/stage-rules.js', 'src/plaza-environment.js', 'src/fire-control.js', 'src/game-guide.js', 'scripts/corn-fire-check.mjs'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
const beforeHashes = await sourceHashes();
const state = page => page.evaluate(() => window.__burgerGame.state);
const nodes = page => page.evaluate(() => window.__burgerGame.nodes);
const settled = page => page.waitForFunction(() => window.__burgerGame.state.projectiles === 0 && window.__burgerGame.state.pendingBursts === 0, null, { timeout: 12000 });
const visibleTargets = page => page.evaluate(() => window.__burgerGame.targets.filter(target => target.x > 14 && target.x < innerWidth - 14 && target.y > 72 && target.y < innerHeight - 90 && document.elementFromPoint(target.x, target.y)?.id === 'gameCanvas'));
const click = (locator, touch = false) => touch ? locator.tap() : locator.click();

async function ready(page, touch = false) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__burgerGame?.state.phase === 'prep', null, { timeout: 15000 });
  await page.locator('#loading').waitFor({ state: 'detached' });
  const selection = await page.evaluate(() => window.__burgerGame.selection), prepared = buildInventory(selection);
  assert.equal(prepared.spent, 56, 'the existing default meal keeps its 56-coin cost');
  assert.equal(prepared.inventory.corn, 0, 'corn stays separate from the restaurant meal conversion');
  assert.equal(await page.locator('#supplyUsed').textContent(), '56');
  assert.equal(await page.locator('[data-pack]').count(), 6, 'the preparation screen retains its six restaurant foods');
  if (touch) await page.locator('#startButton').tap();
  else {
    await page.locator('#startButton').focus();
    await page.keyboard.press('Space');
  }
  await page.waitForFunction(() => window.__burgerGame.state.phase === 'battle');
  const started = await state(page);
  assert.equal(started.selected, 'corn');
  assert.equal(started.inventory.corn, STARTER_CORN);
  assert.deepEqual(started.inventory, { ...prepared.inventory, corn: STARTER_CORN });
  assert.equal(started.coins, 4); assert.equal(started.spent, 56); assert.equal(started.earned, 0);
  assert.equal(await page.locator('#weaponName').textContent(), '玉米粒');
  assert.equal(await page.locator('#weaponCount').textContent(), String(STARTER_CORN));
  assert.equal(started.guide.status, 'active');
  assert.equal(started.guide.step, 1, 'default corn skips the already-completed equip instruction');
  assert.equal((await page.locator('#gameGuide [data-guide-step]').textContent()).replace(/\s/g, ''), '02/04');
  assert.equal(await page.locator('#gameGuide').isVisible(), true);
  return started;
}

async function keyboardButtonControls(page) {
  const before = await state(page);
  await page.locator('#shopButton').focus();
  await page.keyboard.press('Space');
  await page.locator('#shopDialog[open]').waitFor();
  assert.equal((await state(page)).shots, before.shots, 'Space on the shop button activates the button without firing');
  await page.locator('#shopContinue').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#shopDialog').evaluate(dialog => dialog.open), false, 'Space activates the store continue button inside a modal');
  await page.locator('#helpButton').focus();
  await page.keyboard.press('Space');
  await page.locator('#helpDialog[open]').waitFor();
  await page.locator('#helpDialog .dialog-close').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#helpDialog').evaluate(dialog => dialog.open), false, 'Space activates the help close button inside a modal');
  const after = await state(page);
  assert.equal(after.shots, before.shots, 'native keyboard button activation creates no shots');
  assert.deepEqual(after.inventory, before.inventory, 'native keyboard button activation preserves ammunition');
  assert.equal(after.holding, false);
  return { prepStartWithSpace: true, shopWithSpace: true, helpCloseWithSpace: true, addedShots: 0 };
}

async function choose(page, ammo, touch = false) {
  const control = page.locator(`[data-ingredient="${ammo}"]`);
  await control.scrollIntoViewIfNeeded(); await click(control, touch);
  assert.equal((await state(page)).selected, ammo);
}

async function aimTarget(page, id) {
  const target = (await visibleTargets(page)).find(item => item.id === id);
  assert.ok(target, `${id} has a real visible, unobstructed aiming point`);
  return target;
}

async function oneShot(page, targetId, touch = false) {
  const target = await aimTarget(page, targetId), before = await state(page);
  if (touch) await page.touchscreen.tap(target.x, target.y); else await page.mouse.click(target.x, target.y);
  await settled(page);
  const after = await state(page);
  assert.equal(after.shots, before.shots + 1, 'a quick tap fires exactly once');
  assert.equal(after.inventory[before.selected], before.inventory[before.selected] - 1, 'one shot spends one selected round');
  return { before, after };
}

async function clearWithEightCorn(page) {
  const all = await nodes(page), setpieces = await page.evaluate(() => window.__burgerGame.setpieces);
  const triggers = new Set(setpieces.flatMap(piece => piece.triggerIds));
  const target = (await visibleTargets(page)).filter(item => !triggers.has(item.id)).sort((a, b) => Number(b.ingredient === 'onion') - Number(a.ingredient === 'onion'))[0];
  assert.ok(target && all.find(item => item.id === target.id).cornHp === CORN_HITS_TO_CLEAR, 'an untouched non-trigger food is available');
  const initial = await state(page), hits = [];
  for (let hit = 1; hit <= CORN_HITS_TO_CLEAR; hit++) {
    const shot = await oneShot(page, target.id), current = (await nodes(page)).find(item => item.id === target.id);
    assert.equal(current.cornHp, CORN_HITS_TO_CLEAR - hit, 'each corn contact removes exactly one durability point');
    if (hit < CORN_HITS_TO_CLEAR) {
      assert.equal(current.removed, false, 'the first seven hits keep the target present');
      assert.equal(shot.after.removed, initial.removed);
      assert.equal(shot.after.earned, initial.earned, 'partial damage never pays a clear reward');
      assert.equal(shot.after.coins, initial.coins);
    } else {
      assert.equal(current.removed, true, 'the eighth hit removes the target');
      assert.equal(shot.after.removed, initial.removed + 1, 'corn clears only this ordinary target');
      assert.equal(shot.after.earned, initial.earned + 3);
      assert.equal(shot.after.coins, initial.coins + 3);
    }
    hits.push({ hit, remaining: current.cornHp, removed: current.removed, coins: shot.after.coins });
  }
  assert.equal((await state(page)).inventory.corn, initial.inventory.corn - CORN_HITS_TO_CLEAR);
  return { targetId: target.id, ingredient: target.ingredient, hits };
}

async function openCanvasPoint(page) {
  return page.evaluate(() => {
    // Touch targeting can snap to a nearby control even when the precise point
    // belongs to canvas. Keep the test gesture clear of those hit regions.
    const blockers = [...document.querySelectorAll('button, #gameGuide')].filter(element => element.getClientRects().length).map(element => element.getBoundingClientRect());
    for (const [rx, ry] of [[.91, .42], [.08, .47], [.5, .25], [.94, .62], [.18, .34]]) {
      const x = innerWidth * rx, y = innerHeight * ry;
      if (document.elementFromPoint(x, y)?.id === 'gameCanvas' && blockers.every(rect => x < rect.left - 24 || x > rect.right + 24 || y < rect.top - 24 || y > rect.bottom + 24)) return { x, y };
    }
    return null;
  });
}

async function stopped(page, afterRelease) {
  await page.waitForTimeout(450);
  const afterWait = await state(page);
  assert.equal(afterWait.shots, afterRelease.shots, 'release or cancellation stops creating projectiles');
  assert.equal(afterWait.inventory.corn, afterRelease.inventory.corn, 'release or cancellation stops consuming corn');
  assert.equal(afterWait.holding, false);
  await settled(page);
  return afterWait;
}

async function mouseHold(page) {
  const point = await openCanvasPoint(page); assert.ok(point);
  await page.mouse.move(point.x, point.y);
  const before = await state(page);
  await page.mouse.down(); await page.waitForTimeout(950); await page.mouse.up();
  const released = await state(page), count = released.shots - before.shots;
  assert.ok(count >= 3 && count <= 11, `real mouse hold emits a bounded burst, observed ${count}`);
  assert.equal(before.inventory.corn - released.inventory.corn, count);
  await stopped(page, released);
  assert.equal(released.guide.step, 2, 'a real continuous corn shot advances the guide to combinations');
  assert.equal((await page.locator('#gameGuide [data-guide-step]').textContent()).replace(/\s/g, ''), '03/04');
  return { count, cornBefore: before.inventory.corn, cornAfter: released.inventory.corn };
}

async function keyboardShopCancel(page) {
  const point = await openCanvasPoint(page); assert.ok(point); await page.mouse.move(point.x, point.y);
  await page.locator('#gameCanvas').focus();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'gameCanvas', 'the battlefield owns the continuous-fire shortcut');
  const before = await state(page);
  await page.keyboard.down('Space'); await page.waitForTimeout(620); await page.keyboard.press('KeyB');
  await page.locator('#shopDialog[open]').waitFor();
  const paused = await state(page);
  assert.ok(paused.shots - before.shots >= 3, 'holding Space continuously fires before opening the store');
  assert.equal(paused.holding, false, 'opening the store cancels held keyboard fire');
  await page.waitForTimeout(450);
  assert.deepEqual(await state(page), paused, 'the open store freezes shots, ammunition, target damage and rewards');
  await page.keyboard.up('Space');
  assert.deepEqual(await state(page), paused, 'releasing Space inside the store creates no extra shot');
  await page.keyboard.press('KeyB');
  const resumed = await state(page); assert.equal(resumed.shopOpen, false);
  await stopped(page, resumed);
  return { shotsBefore: before.shots, shotsAtPause: paused.shots, cornAtPause: paused.inventory.corn };
}

async function refill(page) {
  await page.locator('#shopButton').click();
  await page.locator('#shopDialog[open]').waitFor();
  const before = await state(page), beforeNodes = await nodes(page);
  assert.ok(before.coins >= CORN_REFILL_COST, 'the genuine eight-hit clear funds one corn refill');
  assert.equal(await page.locator('#cornRefillButton').isEnabled(), true);
  await page.locator('#cornRefillButton').click();
  const after = await state(page);
  assert.equal(after.inventory.corn, before.inventory.corn + CORN_REFILL_AMOUNT);
  assert.equal(after.coins, before.coins - CORN_REFILL_COST);
  assert.equal(after.spent, before.spent + CORN_REFILL_COST);
  assert.equal(after.earned, before.earned); assert.equal(after.shots, before.shots);
  assert.equal(60 + after.earned - after.spent, after.coins);
  for (const [id, count] of Object.entries(before.inventory)) if (id !== 'corn') assert.equal(after.inventory[id], count);
  assert.deepEqual(await nodes(page), beforeNodes, 'refill preserves the actual damaged restaurant');
  assert.match(await page.locator('#shopMessage').textContent(), /玉米 \+80/);
  assert.equal(await page.locator('#weaponCount').textContent(), String(after.inventory.corn));
  await page.screenshot({ path: `${artifactDir}/corn-refill.png` });
  await page.locator('#shopContinue').click();
  return { coinsBefore: before.coins, coinsAfter: after.coins, cornBefore: before.inventory.corn, cornAfter: after.inventory.corn };
}

async function guideChecks(page) {
  const snapshot = await state(page), allNodes = await nodes(page), setpieces = await page.evaluate(() => window.__burgerGame.setpieces);
  const choices = [];
  for (const target of await visibleTargets(page)) {
    for (const [ammo, quantity] of Object.entries(snapshot.inventory)) {
      if (!quantity || ['corn', 'burgerbomb'].includes(ammo)) continue;
      const outcome = resolveStageHit({ ammo, target: allNodes.find(node => node.id === target.id), neighbors: allNodes, setpieces });
      if (['match', 'combo'].includes(outcome.type) && outcome.removeIds.length && !outcome.setpieceIds.length) choices.push({ ammo, target, outcome });
    }
  }
  choices.sort((a, b) => a.outcome.removeIds.length - b.outcome.removeIds.length);
  const chosen = choices[0]; assert.ok(chosen, 'a remaining genuine ingredient match can teach ingredient combinations');
  await choose(page, chosen.ammo); await oneShot(page, chosen.target.id);
  assert.equal((await state(page)).guide.status, 'active', 'ordinary ingredient success keeps the mechanism lesson active');
  assert.equal((await state(page)).guide.step, 3);
  assert.equal(await page.locator('#gameGuide').getAttribute('data-step'), 'mechanism');
  assert.equal((await page.locator('#gameGuide [data-guide-step]').textContent()).replace(/\s/g, ''), '04/04');
  const liveSnapshot = await state(page), liveNodes = await nodes(page), livePieces = await page.evaluate(() => window.__burgerGame.setpieces);
  let mechanism;
  for (const target of await visibleTargets(page)) {
    if (!liveSnapshot.inventory[target.ingredient]) continue;
    const outcome = resolveStageHit({ ammo: target.ingredient, target: liveNodes.find(node => node.id === target.id), neighbors: liveNodes, setpieces: livePieces });
    if (outcome.setpieceIds.length) { mechanism = { ammo: target.ingredient, target, outcome }; break; }
  }
  assert.ok(mechanism, 'a remaining real mechanism can finish the final lesson');
  await choose(page, mechanism.ammo); await oneShot(page, mechanism.target.id);
  assert.equal((await state(page)).guide.status, 'completed');
  assert.equal(await page.locator('#gameGuide').isVisible(), false);
  await page.locator('#helpButton').click();
  await page.locator('#guideReplayButton').click();
  assert.equal((await state(page)).guide.status, 'active');
  assert.equal((await state(page)).guide.step, 0, 'replay with food loaded starts at the equip-corn instruction');
  assert.equal(await page.locator('#gameGuide').getAttribute('data-step'), 'select');
  await choose(page, 'corn');
  assert.equal((await state(page)).guide.step, 1, 'the actual corn control advances the equip step');
  await page.locator('#gameGuide [data-guide-skip]').click();
  assert.equal((await state(page)).guide.status, 'skipped');
  assert.equal(await page.locator('#gameGuide').isVisible(), false);
  await page.locator('#helpButton').click(); await page.locator('#guideReplayButton').click();
  assert.equal((await state(page)).guide.status, 'active', 'help reopens a previously skipped guide');
  assert.equal((await state(page)).guide.step, 1);
  await page.screenshot({ path: `${artifactDir}/guide-replayed.png` });
  await page.locator('#gameGuide [data-guide-skip]').click();
  return { matchedAmmo: chosen.ammo, matchedTarget: chosen.target.id, mechanismTarget: mechanism.target.id, completion: true, selectionStep: true, skip: true, replay: true };
}

async function touchHolds(page, context) {
  const cdp = await context.newCDPSession(page), point = await openCanvasPoint(page); assert.ok(point);
  const before = await state(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(950);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const released = await state(page), endCount = released.shots - before.shots;
  assert.ok(endCount >= 3 && endCount <= 11, `real touch hold emits a bounded burst, observed ${endCount}`);
  assert.equal(before.inventory.corn - released.inventory.corn, endCount);
  await stopped(page, released);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(650);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  const cancelled = await state(page), cancelCount = cancelled.shots - released.shots;
  assert.ok(cancelCount >= 2 && cancelCount <= 8, `touch cancellation follows a real burst, observed ${cancelCount}`);
  await stopped(page, cancelled);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  const shortCancelled = await state(page);
  assert.equal(shortCancelled.shots, cancelled.shots, 'cancelling a short touch never turns it into a tap shot');
  await stopped(page, shortCancelled);
  await page.screenshot({ path: `${artifactDir}/touch-${page.viewportSize().width}x${page.viewportSize().height}.png` });
  return { endCount, cancelCount, shortCancelAddedShots: 0, final: await state(page) };
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const initial = await ready(page);
  const keyboardControls = await keyboardButtonControls(page);
  const eightHits = await clearWithEightCorn(page);
  const mouse = await mouseHold(page);
  const keyboardPause = await keyboardShopCancel(page);
  const purchase = await refill(page);
  const guide = await guideChecks(page);
  reports.push({ device: 'desktop 1440x900 DPR 2', initial, keyboardControls, eightHits, mouse, keyboardPause, purchase, guide, final: await state(page) });
  await page.close();
  for (const [width, height] of [[390, 844], [844, 390], [360, 640]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const mobile = await context.newPage();
    const initial = await ready(mobile, true);
    reports.push({ device: `touch ${width}x${height}`, initial, ...await touchHolds(mobile, context) });
    await context.close();
  }
  assert.deepEqual(errors, []);
  const afterHashes = await sourceHashes();
  assert.deepEqual(afterHashes, beforeHashes, 'runtime sources stay stable throughout this verification');
  const receipt = { checkedAt: new Date().toISOString(), sourceHashes: afterHashes, errors, reports, notes: 'All gameplay, purchases, guidance and cancellation use actual mouse, keyboard or CDP touch input. Debug getters are read only and choose visible targets; gameplay state is never injected. Touch verification is Chromium emulation.' };
  await fs.writeFile(`${artifactDir}/receipt.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ok: true, devices: reports.map(report => report.device), receipt: `${artifactDir}/receipt.json` }));
} catch (error) {
  await fs.writeFile(`${artifactDir}/failure.json`, JSON.stringify({ checkedAt: new Date().toISOString(), error: error.stack, errors, reports, beforeHashes, afterHashes: await sourceHashes() }, null, 2));
  throw error;
} finally {
  await browser.close();
}
