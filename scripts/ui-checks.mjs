import assert from 'node:assert/strict';

const plainBox = box => box && ({ x: box.x, y: box.y, width: box.width, height: box.height });
const fitsViewport = (box, viewport) => box && box.width > 0 && box.height > 0 && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1;
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

async function auditButton(locator, { touchTarget = false } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const result = await locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    const textBoxes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (rect.width && rect.height) textBoxes.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    return { text: element.innerText.trim(), box: { x: box.x, y: box.y, width: box.width, height: box.height }, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, textBoxes };
  });
  if (touchTarget) assert.ok(result.box.width >= 44 && result.box.height >= 44, `primary control “${result.text}” has a 44 px touch target`);
  assert.ok(result.scrollWidth <= result.clientWidth + 1, `button “${result.text}” has no horizontal overflow`);
  for (const text of result.textBoxes) assert.ok(text.x >= result.box.x - 1.5 && text.y >= result.box.y - 1.5 && text.x + text.width <= result.box.x + result.box.width + 1.5 && text.y + text.height <= result.box.y + result.box.height + 1.5, `button “${result.text}” keeps its text inside the visible control`);
  return { text: result.text, bounds: result.box, touchTarget, textFits: true };
}

async function productType(page, selector) {
  const viewport = page.viewportSize();
  const minimum = viewport.width >= 1000 && viewport.height >= 500 ? 22 : 18;
  const values = await page.locator(selector).evaluateAll(elements => elements.map(element => ({ name: element.textContent.trim(), fontSize: parseFloat(getComputedStyle(element).fontSize), fontWeight: getComputedStyle(element).fontWeight })));
  assert.ok(values.length >= 5, 'at least five real product names are present');
  for (const value of values) assert.ok(value.fontSize >= minimum, `${value.name} is at least ${minimum} px on this viewport`);
  return { minimum, products: values };
}

export async function auditPrepUI(page, { offline = false } = {}) {
  const typography = await productType(page, '[data-pack] .pack-copy > strong');
  const viewport = page.viewportSize();
  assert.equal(await page.locator('.pack-details[open]').count(), 0, 'the menu initially keeps ingredient details collapsed');
  const firstScreen = await page.locator('#packList').evaluate(list => {
    const toBox = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
    const bounds = toBox(list);
    const inside = box => box.x >= bounds.x - 1 && box.y >= bounds.y - 1 && box.x + box.width <= bounds.x + bounds.width + 1 && box.y + box.height <= bounds.y + bounds.height + 1;
    const cards = [...list.querySelectorAll('[data-pack]')].map(row => ({ id: row.dataset.pack, bounds: toBox(row), quantity: toBox(row.querySelector('.quantity-control')) }));
    return { list: bounds, scrollTop: list.scrollTop, cards, completeCards: cards.filter(card => inside(card.bounds)).length, visibleQuantities: cards.filter(card => inside(card.quantity)).length };
  });
  assert.equal(firstScreen.cards.length, 6, 'all six product configurations are present');
  assert.equal(firstScreen.scrollTop, 0, 'first-screen visibility is measured before automatic scrolling');
  const requiredFirstScreenCards = viewport.width === 390 && viewport.height === 844 ? 6 : viewport.width === 360 && viewport.height === 640 ? 4 : null;
  if (requiredFirstScreenCards) {
    assert.ok(firstScreen.completeCards >= requiredFirstScreenCards, `${viewport.width}×${viewport.height} shows ${requiredFirstScreenCards} complete product cards before scrolling`);
    assert.ok(firstScreen.visibleQuantities >= requiredFirstScreenCards, `${viewport.width}×${viewport.height} exposes ${requiredFirstScreenCards} quantity controls before scrolling`);
  }
  let firstCardVisibility = null;
  if (viewport.width >= 700 && viewport.height <= 480) {
    const list = firstScreen.list, card = firstScreen.cards[0].bounds;
    assert.ok(card.height <= list.height + 1, 'short landscape shows a complete product card inside the menu');
    assert.ok(card.y >= list.y - 1 && card.y + card.height <= list.y + list.height + 1, 'the first product title and controls are visible before automatic scrolling');
    firstCardVisibility = { list, card, fullyVisibleBeforeScrolling: true };
  }
  const buttons = [], details = [];
  for (const selector of ['#startButton', '#dataButton']) buttons.push(await auditButton(page.locator(selector), { touchTarget: true }));
  for (const { id } of firstScreen.cards) {
    const row = page.locator(`[data-pack="${id}"]`), summary = row.locator('.pack-details > summary');
    for (const delta of ['-1', '1']) buttons.push(await auditButton(row.locator(`[data-delta="${delta}"]`), { touchTarget: true }));
    buttons.push(await auditButton(summary, { touchTarget: true }));
    await summary.click();
    assert.equal(await page.locator('.pack-details[open]').count(), 1, 'one product detail panel is open at a time');
    assert.equal(await row.locator('.pack-details').evaluate(element => element.open), true, `${id} expands through its visible summary`);
    assert.equal(await row.evaluate(element => element.classList.contains('is-expanded')), true, `${id} uses the full-row expanded layout`);
    const mode = row.locator('.pack-mode');
    if (await mode.count()) buttons.push(await auditButton(mode, { touchTarget: true }));
    const chips = row.locator('.recipe-chip');
    assert.ok(await chips.count() > 0, `${id} exposes its ingredient quantities`);
    const chipChecks = [];
    for (let index = 0; index < await chips.count(); index++) {
      const chip = chips.nth(index); await chip.scrollIntoViewIfNeeded();
      const value = await chip.evaluate(element => {
        const box = element.getBoundingClientRect(), row = element.closest('[data-pack]').getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(element); const text = range.getBoundingClientRect();
        return { label: element.innerText.trim(), fontSize: parseFloat(getComputedStyle(element).fontSize), withinCard: box.left >= row.left - 1 && box.right <= row.right + 1, textFits: text.left >= box.left - 1 && text.right <= box.right + 1, noOverflow: element.scrollWidth <= element.clientWidth + 1 };
      });
      assert.ok(value.fontSize >= 13, `${id} ingredient labels remain at least 13 px`);
      assert.ok(value.withinCard && value.textFits && value.noOverflow, `${id} ingredient label “${value.label}” fits its chip and card`);
      chipChecks.push(value);
    }
    const priceChecks = [];
    const prices = row.locator('.reference-price');
    for (let index = 0; index < await prices.count(); index++) {
      const price = prices.nth(index); await price.scrollIntoViewIfNeeded();
      const bounds = plainBox(await price.boundingBox());
      assert.ok(fitsViewport(bounds, viewport), `${id} reference price is fully visible after opening its details`);
      priceChecks.push({ text: await price.textContent(), bounds });
    }
    details.push({ id, ingredients: chipChecks, referencePrices: priceChecks, expandedThroughSummary: true });
    await summary.click();
    assert.equal(await row.locator('.pack-details').evaluate(element => element.open), false, `${id} closes through its visible summary`);
  }
  for (const selector of ['#helpButton', '#soundButton']) buttons.push(await auditButton(page.locator(selector), { touchTarget: true }));
  let connectionControls = 'offline snapshot';
  if (!offline) {
    assert.equal(await page.locator('#mcpForm').count(), 1);
    assert.equal(await page.locator('#mcpToken').getAttribute('type'), 'password');
    assert.equal(await page.locator('#mcpToken').getAttribute('autocomplete'), 'off');
    for (const selector of ['#mcpConnect', '#mcpSync', '#mcpDisconnect', '#storeSearchButton', '#menuSyncButton', '#quoteButton']) assert.equal(await page.locator(selector).count(), 1, `${selector} remains available in the connection panel`);
    connectionControls = 'form and controls present; password masking preserved; no credentials read or submitted';
  }
  await page.locator('#packList').evaluate(element => { element.scrollTop = 0; });
  return { typography, buttons, details, connectionControls, firstCardVisibility, firstScreen: { ...firstScreen, requiredCompleteCards: requiredFirstScreenCards } };
}

export async function auditBattleUI(page) {
  const viewport = page.viewportSize();
  assert.equal(await page.locator('#weaponReadout').count(), 1, 'the game has one DOM ammunition readout');
  assert.equal(await page.locator('#weaponReadout').evaluate(element => Boolean(element.closest('.combat-loadout'))), true, 'the single DOM readout belongs to the bottom ammunition tray');
  const readout = plainBox(await page.locator('#weaponReadout').boundingBox());
  const tray = plainBox(await page.locator('.combat-loadout').boundingBox());
  assert.ok(fitsViewport(readout, viewport), 'ammunition readout stays inside the viewport');
  assert.ok(fitsViewport(tray, viewport), 'bottom ammunition tray stays inside the viewport');
  const gunDisplay = await page.evaluate(() => window.__burgerGame.gunDisplayBounds ?? null);
  assert.ok(fitsViewport(gunDisplay, viewport), 'the physical gun display stays fully inside the viewport');
  assert.equal(overlaps(gunDisplay, tray), false, 'the ammunition tray leaves the physical gun display visible');
  const buttons = [];
  for (const selector of ['#shopButton', '#backToPrep']) buttons.push(await auditButton(page.locator(selector), { touchTarget: true }));
  const selected = page.locator('#ingredientBar button.is-selected');
  buttons.push(await auditButton(selected, { touchTarget: true }));
  return { readout, tray, gunDisplay, singleDomReadout: true, buttons, physicalScreenScreenshotReview: 'pending' };
}

export async function auditShopUI(page) {
  const typography = await productType(page, '[data-shop-pack] .shop-copy > strong');
  const buttons = [];
  for (const selector of ['#shopClose', '#shopContinue', '[data-shop-pack="fries"] [data-buy]', '[data-shop-pack="bigmac"] [data-mode="whole"]', '[data-shop-pack="bigmac"] [data-mode="split"]']) buttons.push(await auditButton(page.locator(selector), { touchTarget: true }));
  return { typography, buttons };
}
