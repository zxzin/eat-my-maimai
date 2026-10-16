import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { SINGLE_HTML_NAME } from './build-single-html.mjs';
import { resolveStageHit } from '../src/stage-rules.js';
import { auditPrepUI, auditBattleUI, auditShopUI } from './ui-checks.mjs';

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
    const visibleTargets = () => page.evaluate(() => window.__burgerGame.targets.filter(target => target.x >= 14 && target.x <= innerWidth - 14 && target.y >= 72 && target.y <= innerHeight - 92 && document.elementFromPoint(target.x, target.y)?.id === 'gameCanvas'));
    async function openPackDetails(packId) {
      const details = page.locator(`[data-pack="${packId}"] .pack-details`);
      if (!await details.evaluate(element => element.open)) {
        const summary = details.locator('summary');
        await summary.scrollIntoViewIfNeeded();
        await tap(summary);
      }
      await details.locator('.pack-detail-body').waitFor({ state: 'visible' });
      assert.equal(await details.evaluate(element => element.open), true, 'product details open through the visible summary control');
      assert.equal(await page.locator('#packList .pack-details[open]').count(), 1, 'one product disclosure is expanded at a time');
    }
    const start = performance.now();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__burgerGame?.state.phase === 'prep', null, { timeout: 20000 });
    await page.locator('#loading').waitFor({ state: 'detached' });
    const bootMs = Math.round(performance.now() - start);
    assert.equal(await page.title(), '吃我一发麦麦 · KFB 食物餐厅');
    assert.equal(await page.locator('input[type="password"], #mcpToken, #mcpConnect').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const publicSnapshot = await page.evaluate(() => window.__MAIMAI_PUBLIC_SNAPSHOT__);
    const priceChecks = [];
    const ui = { prep: await auditPrepUI(page, { offline: true }) };
    if (publicSnapshot) {
      assert.equal(await page.locator('#menuReference').isVisible(), true, 'the public store and retrieval time are shown');
      const sourceText = await page.locator('#menuReference').textContent();
      assert.ok(sourceText.includes(publicSnapshot.store.name));
      const expectedStamp = await page.evaluate(value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }), publicSnapshot.retrievedAt);
      assert.ok(sourceText.includes(expectedStamp), 'the exact snapshot retrieval time is visible');
      for (const product of publicSnapshot.products.filter(product => Number.isFinite(product.publicPriceYuan))) {
        await openPackDetails(product.packId);
        const price = page.locator(`[data-pack="${product.packId}"] .reference-price`);
        await price.scrollIntoViewIfNeeded();
        const expected = `门店参考 ¥${product.publicPriceYuan.toFixed(2)}`;
        assert.equal(await price.textContent(), expected);
        const bounds = await price.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, 'each reference price scrolls fully into the viewport');
        priceChecks.push({ packId: product.packId, displayed: expected, disclosureOpened: true });
      }
      const openSummary = page.locator('#packList .pack-details[open] > summary');
      if (await openSummary.count()) await tap(openSummary);
      assert.equal(await page.locator('#packList .pack-details[open]').count(), 0, 'the product list returns to its compact state');
      await page.locator('#packList').evaluate(list => { list.scrollTop = 0; });
    }
    await tap(page.locator('#dataButton'));
    await page.locator('#dataDialog[open]').waitFor();
    assert.match(await page.locator('#mcpStatus').textContent(), /离线|快照/);
    if (publicSnapshot) {
      assert.ok((await page.locator('#mcpMessage').textContent()).includes(publicSnapshot.store.name));
      assert.equal(await page.locator('#mcpFoods span').count(), publicSnapshot.products.length);
    }
    await tap(page.locator('#dataDialog [data-close]').last());
    await page.screenshot({ path: path.join(artifactDir, `single-html-prep-${width}x${height}.png`) });
    await tap(page.locator('#startButton'));
    await page.waitForFunction(() => window.__burgerGame.state.phase === 'battle');
    const loaded = await state();
    assert.equal(loaded.inventory.corn, 120, 'the offline loadout includes starter corn');
    assert.equal(await page.locator('#weaponFireMode').textContent(), '高速连射');
    const cornCheck = { starterRounds: loaded.inventory.corn, heldShots: 0 };
    if (!touch) {
      await page.locator('#gameCanvas').focus();
      await page.keyboard.down('Space'); await page.waitForTimeout(500); await page.keyboard.up('Space');
      await page.waitForFunction(() => window.__burgerGame.state.projectiles === 0);
      const released = await state();
      cornCheck.heldShots = released.shots - loaded.shots;
      assert.ok(cornCheck.heldShots >= 3, 'the offline bundle supports continuous fire');
      assert.equal(released.inventory.corn, loaded.inventory.corn - cornCheck.heldShots);
      await page.waitForTimeout(250);
      assert.equal((await state()).shots, released.shots, 'offline continuous fire stops at release');
    }
    const wall = await page.evaluate(() => window.__burgerGame.buildingTargets.find(target => /门柱/.test(target.label) && target.x > 14 && target.x < innerWidth - 14 && target.y > 72 && target.y < innerHeight - 92 && document.elementFromPoint(target.x, target.y)?.id === 'gameCanvas'));
    assert.ok(wall, 'the offline restaurant exposes a real destructible red column');
    const wallBefore = await page.evaluate(id => window.__burgerGame.building.parts.find(part => part.id === id), wall.id);
    const wallState = await state();
    if (touch) await page.touchscreen.tap(wall.x, wall.y); else await page.mouse.click(wall.x, wall.y);
    await page.waitForFunction(shots => window.__burgerGame.state.shots === shots + 1 && window.__burgerGame.state.projectiles === 0, wallState.shots);
    const wallAfter = await page.evaluate(id => window.__burgerGame.building.parts.find(part => part.id === id), wall.id);
    assert.equal(wallAfter.hp, wallBefore.hp - 1, 'offline corn impacts the actual building surface');
    assert.ok(wallAfter.crackCount > 0, 'offline building damage leaves a crack');
    assert.equal((await state()).coins, wallState.coins, 'structural damage preserves food reward rules');
    const buildingCheck = { partId: wall.id, hpBefore: wallBefore.hp, hpAfter: wallAfter.hp, cracks: wallAfter.crackCount };
    const before = await state();
    ui.battle = await auditBattleUI(page);
    const nodes = await page.evaluate(() => window.__burgerGame.nodes);
    const setpieces = await page.evaluate(() => window.__burgerGame.setpieces);
    assert.equal(setpieces.length, 3, 'the KFB restaurant has three playable mechanisms');
    assert.equal(before.objectives, 0);
    const targets = await visibleTargets();
    const triggerIds = new Set(setpieces.flatMap(piece => piece.triggerIds));
    const choices = [];
    for (const [ammo, count] of Object.entries(before.inventory)) {
      if (!count) continue;
      for (const target of targets) {
        const outcome = resolveStageHit({ ammo, target: nodes.find(node => node.id === target.id), neighbors: nodes, setpieces });
        if (outcome.type === 'match' && triggerIds.has(target.id) && outcome.setpieceIds.length) choices.push({ ammo, target, outcome });
      }
    }
    const choice = choices.sort((a, b) => b.outcome.removeIds.length - a.outcome.removeIds.length)[0];
    assert.ok(choice && choice.outcome.removeIds.length >= 2, 'offline game presents an exposed same-ingredient trigger and its restaurant chain reaction');
    const ammoButton = page.locator(`[data-ingredient="${choice.ammo}"]`);
    await ammoButton.scrollIntoViewIfNeeded();
    await tap(ammoButton);
    assert.equal((await state()).selected, choice.ammo);
    const target = (await visibleTargets()).find(item => item.id === choice.target.id);
    assert.ok(target, 'the trigger stays visible after switching ammunition');
    const feedbackBefore = await page.evaluate(() => window.__burgerGame.sceneStats.combat);
    if (touch) await page.touchscreen.tap(target.x, target.y); else await page.mouse.click(target.x, target.y);
    await page.waitForFunction(shots => window.__burgerGame.state.shots === shots + 1 && window.__burgerGame.state.projectiles === 0, before.shots);
    const afterShot = await state();
    assert.equal(afterShot.shots, before.shots + 1);
    assert.equal(afterShot.inventory[choice.ammo], before.inventory[choice.ammo] - 1, 'one released shot consumes one ingredient');
    assert.equal(afterShot.removed - before.removed, choice.outcome.removeIds.length, 'the mechanism removes exactly the food predicted by the stage rules');
    assert.equal(afterShot.earned - before.earned, choice.outcome.removeIds.length * 3);
    assert.equal(afterShot.coins - before.coins, afterShot.earned - before.earned);
    assert.equal(afterShot.objectives, choice.outcome.setpieceIds.length, 'the hit completes its mechanism objectives');
    const clearedMechanisms = await page.evaluate(() => window.__burgerGame.setpieces.filter(piece => piece.cleared).map(piece => piece.id));
    assert.deepEqual(clearedMechanisms.sort(), [...choice.outcome.setpieceIds].sort());
    assert.equal(await page.locator('#setpieceGoals [data-state="cleared"]').count(), afterShot.objectives, 'the HUD displays the actual cleared mechanisms');
    const feedbackAfter = await page.evaluate(() => window.__burgerGame.sceneStats.combat);
    assert.equal(feedbackAfter.fireEvents, feedbackBefore.fireEvents + 1, 'the actual shot emits muzzle feedback');
    assert.equal(feedbackAfter.hitEvents, feedbackBefore.hitEvents + 1, 'the actual impact emits combat feedback');
    assert.ok(feedbackAfter.drawCalls <= 6 && feedbackAfter.active <= feedbackAfter.capacity, 'combat feedback stays within its fixed rendering budget');
    await page.waitForFunction(() => window.__burgerGame.state.pendingBursts === 0);
    const chainCheck = { ammo: choice.ammo, triggerId: target.id, clearedMechanisms, removed: afterShot.removed - before.removed, earned: afterShot.earned - before.earned, feedback: { fireEvents: feedbackAfter.fireEvents - feedbackBefore.fireEvents, hitEvents: feedbackAfter.hitEvents - feedbackBefore.hitEvents } };
    await tap(page.locator('#shopButton'));
    await page.locator('#shopDialog[open]').waitFor();
    ui.shop = await auditShopUI(page);
    if (publicSnapshot) for (const product of publicSnapshot.products.filter(product => Number.isFinite(product.publicPriceYuan))) {
      assert.equal(await page.locator(`[data-shop-pack="${product.packId}"] .reference-price`).textContent(), `门店参考 ¥${product.publicPriceYuan.toFixed(2)}`);
    }
    const buy = page.locator('[data-shop-pack="fries"] [data-buy]');
    assert.equal(await buy.isEnabled(), true);
    await tap(buy);
    const afterBuy = await state();
    assert.equal(afterBuy.coins, afterShot.coins - 10);
    assert.equal(afterBuy.inventory.fry, afterShot.inventory.fry + 6);
    assert.equal(afterBuy.objectives, afterShot.objectives, 'restocking preserves the triggered mechanisms');
    await tap(page.locator('#shopContinue'));
    assert.equal((await state()).shopOpen, false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(artifactDir, `single-html-battle-${width}x${height}.png`) });
    assert.deepEqual(errors, []);
    const externalRequests = requests.filter(url => !url.startsWith('file:') && !url.startsWith('data:') && !url.startsWith('blob:'));
    assert.deepEqual(externalRequests, [], 'single HTML makes no network request while playing and shopping');
    reports.push({ viewport: `${width}x${height}`, ui, input: touch ? 'Chromium touch emulation' : 'desktop mouse', bootMs, shots: afterBuy.shots, removed: afterBuy.removed, coins: afterBuy.coins, cornCheck, buildingCheck, chainCheck, publicSnapshot: Boolean(publicSnapshot), snapshotStore: publicSnapshot?.store?.name ?? null, snapshotRetrievedAt: publicSnapshot?.retrievedAt ?? null, priceChecks, networkRequests: externalRequests.length, pageErrors: errors, scene: await page.evaluate(() => window.__burgerGame.sceneStats) });
    await context.close();
  }
  assert.deepEqual(await fs.readFile(htmlPath), html, 'the single HTML stays unchanged throughout all offline device checks');
  const receipt = { checkedAt: new Date().toISOString(), file: SINGLE_HTML_NAME, sha256: createHash('sha256').update(html).digest('hex'), bytes: html.byteLength, transport: 'file://', network: 'browser offline', reports, physicalPhoneVerified: false, platformUploadVerified: false };
  await fs.writeFile(path.join(artifactDir, 'single-html-browser-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} finally { await browser.close(); }
