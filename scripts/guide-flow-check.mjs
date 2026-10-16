import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveStageHit } from '../src/stage-rules.js';
import { GUIDE_STORAGE_KEY } from '../src/game-guide.js';

const origin = process.env.GAME_URL || 'http://127.0.0.1:5178/';
const artifactDir = 'artifacts/guide-world';
await fs.mkdir(artifactDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const reports = [], errors = [];
const hashSources = async () => {
  const files = ['index.html', ...await fs.readdir('src').then(files => files.filter(file => /\.(js|css)$/.test(file)).map(file => `src/${file}`)), 'scripts/guide-flow-check.mjs'];
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
};
const beforeHashes = await hashSources();
const state = page => page.evaluate(() => window.__burgerGame.state);
const scene = page => page.evaluate(() => ({ nodes: window.__burgerGame.nodes, setpieces: window.__burgerGame.setpieces, targets: window.__burgerGame.targets.filter(target => target.x > 14 && target.x < innerWidth - 14 && target.y > 72 && target.y < innerHeight - 90 && document.elementFromPoint(target.x, target.y)?.id === 'gameCanvas') }));
const settle = page => page.waitForFunction(() => window.__burgerGame.state.projectiles === 0 && window.__burgerGame.state.pendingBursts === 0, null, { timeout: 12000 });
const box = rect => rect && ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
const overlaps = (a, b) => a.x < b.x + b.width - 1 && a.x + a.width > b.x + 1 && a.y < b.y + b.height - 1 && a.y + a.height > b.y + 1;
const tap = (locator, touch) => touch ? locator.tap() : locator.click();

async function ready(page) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__burgerGame?.state.phase === 'prep');
  await page.locator('#loading').waitFor({ state: 'detached' });
}
async function currentGuide(page, expected, counter) {
  const selector = expected === 'prep' ? '#prepGuide' : '#gameGuide';
  await page.waitForFunction(({ selector, step }) => (step === 'prep' ? window.__burgerGame.state.guide.stage === 'prep' : document.querySelector(selector)?.dataset.step === step) && !document.querySelector(selector).hidden, { selector, step: expected });
  assert.equal((await state(page)).guide.status, 'active');
  assert.equal((await page.locator(`${selector} [data-guide-step]`).textContent()).replace(/\s/g, ''), counter);
  const reading = await page.locator(selector).evaluate(root => {
    const toBox = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const read = selector => {
      const element = root.querySelector(selector), style = getComputedStyle(element), range = document.createRange();
      range.selectNodeContents(element);
      return { text: element.textContent.trim(), fontSize: parseFloat(style.fontSize), fontWeight: style.fontWeight, box: toBox(element), texts: [...range.getClientRects()].map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })), overflow: element.scrollWidth > element.clientWidth + 1 };
    };
    const skip = root.querySelector('[data-guide-skip]'), rect = skip.getBoundingClientRect();
    return { box: toBox(root), title: read('[data-guide-title]'), body: read('[data-guide-body]'), skip: toBox(skip), skipReachable: skip.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)), color: getComputedStyle(root).backgroundColor };
  });
  const viewport = page.viewportSize();
  assert.ok(reading.box.x >= -1 && reading.box.y >= -1 && reading.box.x + reading.box.width <= viewport.width + 1 && reading.box.y + reading.box.height <= viewport.height + 1, `${expected} guide stays on screen`);
  const shortLandscape = viewport.width >= 700 && viewport.height <= 480;
  const minimumTitle = shortLandscape ? 18 : viewport.width < 700 ? 19 : 20;
  const minimumBody = shortLandscape ? 13 : 14;
  assert.ok(reading.title.fontSize >= minimumTitle, `${expected} title is at least ${minimumTitle} px`);
  assert.ok(reading.body.fontSize >= minimumBody, `${expected} explanation is at least ${minimumBody} px`);
  assert.ok(Number(reading.title.fontWeight) >= 700, `${expected} title is bold`);
  assert.ok(reading.skip.width >= 44 && reading.skip.height >= 44 && reading.skipReachable, `${expected} skip has a visible 44 px target`);
  for (const content of [reading.title, reading.body]) {
    assert.ok(!content.overflow, `${expected} ${content.text} has no horizontal overflow`);
    for (const text of content.texts) if (text.width && text.height) {
      assert.ok(text.x >= reading.box.x - 1 && text.y >= reading.box.y - 1 && text.x + text.width <= reading.box.x + reading.box.width + 1 && text.y + text.height <= reading.box.y + reading.box.height + 1, `${expected} text remains inside the guide`);
    }
  }
  const protectedSelectors = (await state(page)).phase === 'prep' ? ['#startButton', '.quantity-control'] : ['#helpButton', '#shopButton', '#backToPrep', '.combat-loadout', '#setpieceGoals'];
  const controls = [];
  for (const selector of protectedSelectors) for (const control of await page.locator(selector).all()) {
    if (!await control.isVisible()) continue;
    const bounds = box(await control.boundingBox());
    assert.equal(overlaps(reading.box, bounds), false, `${expected} guide leaves ${selector} unobstructed`);
    if (await control.evaluate(element => element.tagName === 'BUTTON')) {
      assert.ok(bounds.width >= 44 && bounds.height >= 44, `${selector} keeps a 44 px interaction area`);
      assert.equal(await control.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); }), true, `${selector} is reachable above overlays`);
    }
    controls.push({ selector, box: bounds });
  }
  let firstScreenCards = null;
  if (expected === 'prep') {
    firstScreenCards = await page.locator('#packList').evaluate(list => {
      const toBox = element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; };
      const bounds = toBox(list);
      const contained = rect => rect.x >= bounds.x - 1 && rect.y >= bounds.y - 1 && rect.x + rect.width <= bounds.x + bounds.width + 1 && rect.y + rect.height <= bounds.y + bounds.height + 1;
      const cards = [...list.querySelectorAll('[data-pack]')].map(element => ({ id: element.dataset.pack, bounds: toBox(element), quantity: toBox(element.querySelector('.quantity-control')) }));
      return { list: bounds, scrollTop: list.scrollTop, cards, completeCards: cards.filter(card => contained(card.bounds)).length, visibleQuantities: cards.filter(card => contained(card.quantity)).length };
    });
    assert.equal(firstScreenCards.scrollTop, 0, 'preparation visibility is checked before any scrolling');
    assert.equal(firstScreenCards.cards.length, 6, 'all six meal configurations remain available');
    const required = viewport.width === 390 && viewport.height === 844 ? 6 : viewport.width === 360 && viewport.height === 640 ? 4 : null;
    firstScreenCards.required = required;
    if (required) {
      assert.ok(firstScreenCards.completeCards >= required, `${viewport.width}×${viewport.height} shows ${required} complete product cards before scrolling; observed ${firstScreenCards.completeCards}`);
      assert.ok(firstScreenCards.visibleQuantities >= required, `${viewport.width}×${viewport.height} exposes ${required} quantity controls before scrolling`);
    }
  }
  const goalCaptions = await page.locator('.setpiece-goal small').evaluateAll(elements => elements.filter(element => element.getClientRects().length).map(element => ({ text: element.textContent.trim(), fontSize: parseFloat(getComputedStyle(element).fontSize), overflow: element.scrollWidth > element.clientWidth + 1 })));
  for (const caption of goalCaptions) {
    assert.ok(caption.fontSize >= 13, 'mechanism instruction remains at least 13 px');
    assert.equal(caption.overflow, false, 'mechanism instruction fits its objective chip');
  }
  return { step: expected, counter, ...reading, controls, firstScreenCards, goalCaptions, minimumTitle, minimumBody };
}
async function choose(page, ammo, touch) {
  const button = page.locator(`[data-ingredient="${ammo}"]`);
  await button.scrollIntoViewIfNeeded(); await tap(button, touch);
  assert.equal((await state(page)).selected, ammo);
}
async function fire(page, targetId, touch) {
  const target = (await scene(page)).targets.find(target => target.id === targetId);
  assert.ok(target, `target ${targetId} is visible through the live camera`);
  const before = await state(page);
  if (touch) await page.touchscreen.tap(target.x, target.y); else await page.mouse.click(target.x, target.y);
  await settle(page);
  assert.equal((await state(page)).shots, before.shots + 1, 'a genuine click or tap fires one projectile');
}
async function hold(page, context, touch) {
  const point = await page.evaluate(() => {
    const protectedBoxes = [...document.querySelectorAll('button, #gameGuide')].filter(element => element.getClientRects().length).map(element => element.getBoundingClientRect());
    for (const [rx, ry] of [[.91, .42], [.08, .47], [.5, .25], [.94, .62], [.18, .34], [.7, .55]]) {
      const x = innerWidth * rx, y = innerHeight * ry;
      if (document.elementFromPoint(x, y)?.id === 'gameCanvas' && protectedBoxes.every(rect => x < rect.left - 24 || x > rect.right + 24 || y < rect.top - 24 || y > rect.bottom + 24)) return { x, y };
    }
    return null;
  });
  assert.ok(point, 'a safe canvas area is available for the first held gesture');
  const before = await state(page);
  if (touch) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.waitForTimeout(700); await page.mouse.up();
  }
  await settle(page);
  const after = await state(page);
  assert.ok(after.shots - before.shots >= 2, 'the actual held input produces a burst');
  assert.equal(after.holding, false);
  return { before: before.shots, after: after.shots };
}
async function successChoice(page, mechanism) {
  const snapshot = await state(page), world = await scene(page), choices = [];
  for (const target of world.targets) {
    const ammo = target.ingredient;
    if (!snapshot.inventory[ammo] || ammo === 'corn') continue;
    const outcome = resolveStageHit({ ammo, target: world.nodes.find(node => node.id === target.id), neighbors: world.nodes, setpieces: world.setpieces });
    if (outcome.removeIds.length && (mechanism ? outcome.setpieceIds.length > 0 : !outcome.setpieceIds.length)) choices.push({ ammo, targetId: target.id, outcome });
  }
  choices.sort((a, b) => a.outcome.removeIds.length - b.outcome.removeIds.length);
  assert.ok(choices.length, `an unobstructed ${mechanism ? 'mechanism trigger' : 'ordinary same-ingredient clear'} is available with purchased food`);
  return choices[0];
}
async function replay(page, touch) {
  await tap(page.locator('#helpButton'), touch);
  await page.locator('#helpDialog[open]').waitFor();
  await tap(page.locator('#guideReplayButton'), touch);
  assert.equal(await page.locator('#helpDialog').evaluate(dialog => dialog.open), false);
  assert.equal((await state(page)).guide.status, 'active');
}
async function completedPersists(page, touch) {
  const stored = await page.evaluate(key => localStorage.getItem(key), GUIDE_STORAGE_KEY);
  assert.equal(stored, 'completed');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__burgerGame?.state.phase === 'prep');
  assert.equal(await page.locator('#prepGuide').isVisible(), false, 'finished players return to a clean preparation screen');
  await tap(page.locator('#startButton'), touch);
  assert.equal(await page.locator('#gameGuide').isVisible(), false, 'completion survives a fresh round after reload');
}

try {
  for (const [width, height, touch] of [[1440, 900, false], [390, 844, true], [360, 640, true], [844, 390, true]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: touch ? 1 : 2, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), device = `${width}x${height}`;
    await ready(page);
    const prep = await currentGuide(page, 'prep', '01/04');
    await page.screenshot({ path: `${artifactDir}/prep-${device}.png` });
    const initial = await state(page);
    assert.equal(initial.shots, 0); assert.equal(initial.spent, 0, 'reading preparation guidance does not purchase or start a game');
    await tap(page.locator('#startButton'), touch);
    const fireGuide = await currentGuide(page, 'fire', '02/04');
    await page.screenshot({ path: `${artifactDir}/fire-${device}.png` });
    const burst = await hold(page, context, touch);
    const combine = await currentGuide(page, 'combine', '03/04');
    await page.screenshot({ path: `${artifactDir}/combine-${device}.png` });
    const matching = await successChoice(page, false);
    await choose(page, matching.ammo, touch); await fire(page, matching.targetId, touch);
    const afterMatch = await state(page);
    assert.equal(afterMatch.guide.status, 'active', 'ordinary ingredient success keeps the final mechanism lesson active');
    assert.equal(afterMatch.objectives, 0, 'this lesson used ordinary food rather than an already-cleared mechanism');
    const mechanism = await currentGuide(page, 'mechanism', '04/04');
    await page.screenshot({ path: `${artifactDir}/mechanism-${device}.png` });
    const trigger = await successChoice(page, true);
    await choose(page, trigger.ammo, touch); await fire(page, trigger.targetId, touch);
    const finished = await state(page);
    assert.ok(finished.objectives >= 1, 'an actual mechanism was triggered');
    assert.equal(finished.guide.status, 'completed');
    assert.equal(await page.locator('#gameGuide').isVisible(), false);
    await page.screenshot({ path: `${artifactDir}/completed-${device}.png` });
    await completedPersists(page, touch);
    await replay(page, touch);
    assert.equal(await page.locator('#gameGuide').getAttribute('data-step'), 'fire', 'help replays guidance with corn already loaded');
    await tap(page.locator('#gameGuide [data-guide-skip]'), touch);
    assert.equal((await state(page)).guide.status, 'skipped');
    assert.equal(await page.locator('#gameGuide').isVisible(), false);
    reports.push({ device, touchEmulation: touch, prep, fireGuide, burst, combine, matching, mechanism, trigger, finished, persistsAfterReload: true, replayAndSkip: true });
    await context.close();
  }
  const skipContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const skipPage = await skipContext.newPage();
  await ready(skipPage);
  await tap(skipPage.locator('#prepGuide [data-guide-skip]'), true);
  assert.equal((await state(skipPage)).guide.status, 'skipped');
  assert.equal((await state(skipPage)).phase, 'prep');
  await skipPage.reload({ waitUntil: 'networkidle' });
  await skipPage.waitForFunction(() => window.__burgerGame?.state.phase === 'prep');
  assert.equal(await skipPage.locator('#prepGuide').isVisible(), false);
  await replay(skipPage, true);
  assert.equal((await state(skipPage)).phase, 'prep', 'replay from preparation preserves the menu and budget');
  assert.equal((await state(skipPage)).spent, 0);
  assert.equal((await state(skipPage)).guide.stage, 'prep');
  await skipContext.close();
  assert.deepEqual(errors, []);
  const sourceHashes = await hashSources();
  assert.deepEqual(sourceHashes, beforeHashes, 'the runtime remains unchanged during final verification');
  const receipt = { checkedAt: new Date().toISOString(), origin, sourceHashes, errors, firstVisitSkipAndReplay: true, reports, notes: 'The guide is advanced using real mouse/touch input and actual projectile collisions. Read-only debug getters select visible targets. Touch checks use Chromium mobile emulation.' };
  await fs.writeFile(`${artifactDir}/guide-flow-receipt.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ok: true, devices: reports.map(report => report.device), receipt: `${artifactDir}/guide-flow-receipt.json` }));
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: `${artifactDir}/failure.png` }).catch(() => {});
  await fs.writeFile(`${artifactDir}/guide-flow-failure.json`, JSON.stringify({ checkedAt: new Date().toISOString(), error: error.stack, errors, reports, beforeHashes, afterHashes: await hashSources() }, null, 2));
  throw error;
} finally { await browser.close(); }
