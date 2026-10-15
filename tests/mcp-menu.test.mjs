import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShanghaiStoreSearch, buildPickupMenuArguments, buildPickupQuoteArguments, normalizeStores, normalizeMenu, matchPackPrices, normalizeMealDetail, normalizeQuote, createPublicMenuSnapshot, menuIdentityCandidates, enrichMenuIdentities } from '../src/mcp-menu.js';
import { READ_ONLY_TOOLS, validateQueryScope } from '../server/mcd-mcp.js';
import { PACKS } from '../src/ingredient-rules.js';

const retrievedAt = '2026-10-15T01:02:03.000Z';
const store = { code: 'fixture-store', name: '上海公开地标示例店', address: '公开示例地址', beCode: 'fixture-be' };
const response = data => ({ retrievedAt, result: { content: [{ type: 'text', text: JSON.stringify({ success: true, code: 200, data }) }] } });

test('pickup helpers search a Shanghai public landmark and omit beCode from pickup parameters', () => {
  assert.deepEqual(buildShanghaiStoreSearch(), { searchType: 2, beType: 1, city: '上海市', keyword: '人民广场' });
  assert.deepEqual(buildPickupMenuArguments(store), { storeCode: store.code, orderType: 1, beType: 1 });
  assert.throws(() => buildShanghaiStoreSearch(' '));
  assert.throws(() => buildPickupMenuArguments(null));
  assert.deepEqual(buildPickupQuoteArguments(store, [{ productCode: 'one', quantity: 2, couponId: 'discarded' }]).items, [{ productCode: 'one', quantity: 2 }]);
  assert.throws(() => buildPickupQuoteArguments(store, [{ productCode: 'one', quantity: 0 }]));
});

test('server permits public landmark lookup and blocks favorites, coordinates and member inputs', () => {
  assert.ok(READ_ONLY_TOOLS.includes('query-nearby-stores'));
  assert.ok(!READ_ONLY_TOOLS.includes('create-order'));
  assert.doesNotThrow(() => validateQueryScope('query-nearby-stores', buildShanghaiStoreSearch()));
  for (const args of [{ searchType: 1, beType: 1 }, { searchType: 3, longitude: 1, latitude: 2, beType: 1 }, { ...buildShanghaiStoreSearch(), longitude: 1 }]) {
    assert.throws(() => validateQueryScope('query-nearby-stores', args), { code: 'query-scope' });
  }
  assert.throws(() => validateQueryScope('calculate-price', { items: [{ couponId: 'private' }] }), { code: 'query-scope' });
  assert.throws(() => validateQueryScope('query-meals', { withOrder: {} }), { code: 'query-scope' });
});

test('stores are deduplicated with public fields only and preserve closed status', () => {
  const stores = normalizeStores(response([
    { storeCode: 'a', storeName: '上海示例店', address: '测试路1号', beCode: 'b', businessStatus: false, distance: 'near', favorite: true, phone: 'private', secret: 'private' },
    { storeCode: 'a', storeName: 'duplicate' }, { storeName: 'missing code' },
  ]));
  assert.deepEqual(stores, [{ code: 'a', name: '上海示例店', address: '测试路1号', beCode: 'b', businessStatus: false }]);
  assert.ok(!JSON.stringify(stores).includes('private'));
});

test('menu parsing respects yuan units and excludes account discounts and frequent products', () => {
  const menu = normalizeMenu(response({ frequent: [{ name: '私有常点', code: 'secret' }], meals: {
    one: { name: '巨无霸', currentPrice: '25.5', originalPrice: '26', discountType: null },
    two: { name: '麦乐鸡5块', currentPrice: '9.9', originalPrice: '15', discountType: '促销优惠' },
    three: { name: '中薯条', currentPrice: '1', originalPrice: '13', discountType: '麦金卡优惠', withOrder: { member: 'private' } },
    four: { name: '麦香鱼', currentPrice: '2', discountType: '随单购早餐卡优惠' },
    five: { name: '麦辣鸡腿汉堡', currentPrice: '', originalPrice: 'NaN' },
    six: { name: '额外餐品', currentPrice: '5', originalPrice: '8', discountType: 'future-unknown' },
  } }), { store });
  assert.deepEqual(menu.items.map(item => item.publicPriceYuan), [25.5, 9.9, 13, null, null, 8]);
  assert.deepEqual(menu.items.map(item => item.priceSource), ['menu-current', 'public-promotion', 'menu-original', 'unknown', 'unknown', 'menu-original']);
  assert.equal(menu.retrievedAt, retrievedAt);
  assert.equal(menu.itemCount, 6);
  assert.deepEqual(menu.store, { code: store.code, name: store.name });
  assert.ok(!JSON.stringify(menu).includes('private'));
  assert.ok(!JSON.stringify(menu).includes('私有常点'));
  assert.ok(!JSON.stringify(menu).includes('麦金卡'));
});

test('unrecognized and failed results produce no menu or stores', () => {
  for (const input of [null, 'plain text', {}, { isError: true, structuredContent: { meals: { a: { name: '巨无霸', currentPrice: 1 } } } },
    response({ success: false, meals: { a: { name: '巨无霸' } } }),
    { content: [{ type: 'text', text: '巨无霸 ¥25.5' }] },
    { structuredContent: { success: true, code: 500, data: { meals: { a: { name: '巨无霸' } } } } }]) {
    assert.equal(normalizeMenu(input).itemCount, 0);
    assert.deepEqual(normalizeStores(input), []);
  }
});

test('exact pack matches support aliases and reject differently sized meals and ambiguous codes', () => {
  const menu = normalizeMenu(response({ meals: {
    one: { name: '麦乐鸡5块', currentPrice: '15' }, two: { name: '巨无霸套餐', currentPrice: '35' },
    three: { name: '麦香鱼', currentPrice: '18' }, four: { name: '麦香鱼', currentPrice: '20' },
  } }));
  const matches = matchPackPrices(menu, [
    { id: 'nuggets', name: '五块麦乐鸡', mcpAliases: ['麦乐鸡5块'] },
    { id: 'bigmac', name: '巨无霸' }, { id: 'fish', name: '麦香鱼' },
  ]);
  assert.deepEqual(matches.matched.map(item => item.packId), ['nuggets']);
  assert.deepEqual(matches.unmatched, ['bigmac', 'fish']);
  assert.deepEqual(matches.ambiguous, ['fish']);
});

test('detail exposes only explicit customization counts and no complete recipe claims', () => {
  const detail = normalizeMealDetail(response({ code: 'a', name: '巨无霸', price: 'private-member-price', supportModify: true, rounds: [], modification: { items: [{ values: [
    { code: 'sauce', name: '酱料', selectedQuantity: 1, minQuantity: 0, maxQuantity: 1, selectedKey: 'private', price: 0 },
  ] }] } }));
  assert.deepEqual(detail.options, [{ code: 'sauce', name: '酱料', selectedQuantity: 1, minQuantity: 0, maxQuantity: 1 }]);
  assert.equal(detail.supportModify, true);
  assert.equal(detail.hasChoices, false);
  assert.ok(!JSON.stringify(detail).includes('private'));
});

test('quote converts cents exactly, keeps unknown charges null and remains ineligible for public snapshots', () => {
  const quote = normalizeQuote(response({ price: 2200, productPrice: 1600, originalPrice: 2200, deliveryPrice: 600, discount: 0, tablewarePrice: 10,
    productList: [{ productCode: 'one', productName: '餐品', quantity: 2, subtotal: 1600, originalSubtotal: 1600, couponCode: 'private' }], member: 'private' }));
  assert.equal(quote.totalYuan, 22);
  assert.equal(quote.productYuan, 16);
  assert.equal(quote.deliveryYuan, 6);
  assert.equal(quote.tablewareYuan, 0.1);
  assert.equal(quote.discountYuan, 0);
  assert.equal(quote.items[0].subtotalYuan, 16);
  assert.equal(quote.publicSnapshotEligible, false);
  assert.ok(!JSON.stringify(quote).includes('private'));
  assert.equal(normalizeQuote(response({ price: 123.5 })), null);
  assert.equal(normalizeQuote(response({ price: 100 })).deliveryYuan, null);
  assert.equal(createPublicMenuSnapshot(quote), null);
});

test('public snapshot copies only source, public store identity and public menu prices', () => {
  const menu = normalizeMenu(response({ meals: { one: { name: '巨无霸', currentPrice: '25.5' } } }), { store });
  menu.frequent = 'private'; menu.token = 'private'; menu.items[0].couponId = 'private'; menu.store.contact = 'private';
  const snapshot = createPublicMenuSnapshot(menu);
  assert.equal(snapshot.items[0].publicPriceYuan, 25.5);
  assert.ok(!JSON.stringify(snapshot).includes('private'));
  assert.equal(createPublicMenuSnapshot({ ...menu, retrievedAt: null }), null);
});

test('generic menu labels require same-code precise detail names before pack matching', async () => {
  const original = normalizeMenu(response({ meals: {
    '1401': { name: '麦乐鸡', currentPrice: '14' }, '4810': { name: '薯条', currentPrice: '13.5' },
  } }), { store });
  assert.deepEqual(matchPackPrices(original, PACKS).matched, []);
  assert.equal(menuIdentityCandidates(original, PACKS).length, 2);
  const calls = [];
  const enriched = await enrichMenuIdentities(original, PACKS, { loadDetail: async code => {
    calls.push(code); return response({ code, name: code === '1401' ? '麦乐鸡5块' : '中薯条', rounds: [] });
  } });
  assert.deepEqual(calls, ['1401', '4810']);
  const matched = matchPackPrices(enriched.menu, PACKS).matched;
  assert.deepEqual(matched.map(item => [item.packId, item.code, item.publicPriceYuan]), [['nuggets', '1401', 14], ['fries', '4810', 13.5]]);
  assert.equal(original.items[0].name, '麦乐鸡');
  assert.equal(enriched.details.get('4810').name, '中薯条');
});

test('large fries, four nuggets and a different-code detail never unlock the medium/five-piece packs', async () => {
  const menu = normalizeMenu(response({ meals: { nugget: { name: '麦乐鸡', currentPrice: '14' }, fries: { name: '薯条', currentPrice: '13.5' } } }), { store });
  for (const wrongCode of [false, true]) {
    const enriched = await enrichMenuIdentities(menu, PACKS, { loadDetail: async code => response({
      code: wrongCode ? `other-${code}` : code,
      name: code === 'nugget' ? wrongCode ? '麦乐鸡5块' : '麦乐鸡4块' : wrongCode ? '中薯条' : '大薯条', rounds: [],
    }) });
    assert.deepEqual(matchPackPrices(enriched.menu, PACKS).matched, []);
  }
});

test('identity enrichment stops on invalidation and propagates authentication failures', async () => {
  const menu = normalizeMenu(response({ meals: { one: { name: '麦乐鸡' }, two: { name: '薯条' } } }), { store });
  let current = true, calls = 0;
  const stopped = await enrichMenuIdentities(menu, PACKS, { isCurrent: () => current, loadDetail: async code => {
    calls += 1; current = false; return response({ code, name: '麦乐鸡5块', rounds: [] });
  } });
  assert.equal(calls, 1); assert.equal(stopped.details.size, 0);
  assert.deepEqual(matchPackPrices(stopped.menu, PACKS).matched, []);
  await assert.rejects(enrichMenuIdentities(menu, PACKS, { loadDetail: async () => { throw Object.assign(new Error('expired'), { code: 'needs-auth' }); } }), { code: 'needs-auth' });
});
