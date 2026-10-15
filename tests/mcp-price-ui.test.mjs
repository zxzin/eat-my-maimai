import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMcpPriceUI } from '../src/mcp-price-ui.js';
import { setupMcpUI } from '../src/mcp-ui.js';

class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = true;
    this.children = []; this.handlers = {}; this.dataset = {};
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, force) => force ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) };
  }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  fire(name) { return this.handlers[name]?.({ preventDefault() {} }); }
}
const timestamp = '2026-10-15T02:03:04.000Z';
const response = data => ({ retrievedAt: timestamp, result: { structuredContent: { success: true, code: 200, data } } });
const menuResponse = response({ meals: {
  burger: { name: '巨无霸', currentPrice: '1', originalPrice: '25', discountType: '麦金卡优惠' },
  nuggets: { name: '麦乐鸡5块', currentPrice: '12', discountType: null },
} });
const nutrition = { retrievedAt: timestamp, foodCount: 158, matched: [{ id: 'bigmac' }, { id: 'nuggets' }] };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function tickUntil(predicate) { for (let i = 0; i < 20 && !predicate(); i += 1) await Promise.resolve(); assert.ok(predicate(), 'fixture operation reached expected boundary'); }
function fixture(overrides = {}, selection = ['bigmac', 'bigmac', 'nuggets']) {
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  globalThis.document = { getElementById: el, createElement: () => new Element() };
  const calls = { snapshots: [], stores: [], menus: [], details: [], quotes: [] };
  const api = {
    loadMcpStores: async args => { calls.stores.push(args); return response([
      { storeCode: 'closed', storeName: '上海关闭示例店', businessStatus: false },
      { storeCode: 'first', storeName: '上海第一示例店', address: '公开地标甲', businessStatus: true },
      { storeCode: 'second', storeName: '上海第二示例店', address: '公开地标乙', businessStatus: true },
    ]); },
    loadMcpMenu: async args => { calls.menus.push(args); return menuResponse; },
    loadMcpMealDetail: async args => { calls.details.push(args); return response({ code: args.code, name: '示例餐品', rounds: [], modification: { items: [{ values: [{ code: 'sauce', name: '酱料', selectedQuantity: 1, minQuantity: 0, maxQuantity: 1 }] }] } }); },
    loadMcpQuote: async args => { calls.quotes.push(args); return response({ price: 6200 }); },
    ...overrides,
  };
  const controller = setupMcpPriceUI({ api, onMenu: data => calls.snapshots.push(data), getSelection: () => selection });
  controller.setConnected(true);
  return { api, el, calls, controller, refresh: () => controller.refresh(nutrition) };
}

// Synthetic DOM and API responses keep these tests independent of credentials,
// the local server, account data and official network availability.
test('default Shanghai search chooses an open store and publishes only public menu prices', async () => {
  const f = fixture(); await f.refresh();
  assert.deepEqual(f.calls.stores, [{ searchType: 2, beType: 1, city: '上海市', keyword: '人民广场' }]);
  assert.deepEqual(f.calls.menus, [{ storeCode: 'first', orderType: 1, beType: 1 }]);
  const snapshot = f.calls.snapshots.at(-1);
  assert.equal(snapshot.store.name, '上海第一示例店');
  assert.equal(snapshot.store.city, '上海市');
  assert.equal(snapshot.retrievedAt, timestamp);
  assert.deepEqual(snapshot.products.map(item => item.publicPriceYuan), [25, 12]);
  assert.equal(f.el('menuResults').children[0].children[2].textContent, '门店原价');
  assert.match(f.el('menuResults').children[0].children[3].children[1].textContent, /酱料/);
  assert.equal(f.el('quoteButton').disabled, false);
  assert.equal(f.el('storeSelect').value, 'first');
});

test('optional details run sequentially and null or failed details preserve successful prices', async () => {
  let active = 0, peak = 0, count = 0;
  const f = fixture({ loadMcpMealDetail: async () => {
    active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1;
    if (++count === 1) return response({});
    throw new Error('Synthetic optional detail failure');
  } });
  await f.refresh();
  assert.equal(peak, 1);
  assert.equal(count, 2);
  assert.equal(f.calls.snapshots.at(-1).products.length, 2);
  assert.equal(f.el('menuResults').children[0].children.length, 3);
  assert.equal(f.el('menuMessage').classList.contains('is-error'), false);
});

test('unknown menu prices and null quotes remain explicitly unknown and never display zero', async () => {
  const f = fixture({ loadMcpMenu: async () => response({ meals: { burger: { name: '巨无霸' } } }), loadMcpQuote: async () => response({ unrelated: true }) }, ['bigmac']);
  await f.refresh();
  assert.equal(f.calls.snapshots.at(-1).products[0].publicPriceYuan, null);
  assert.equal(f.el('menuResults').children[0].children[1].textContent, '价格待核验');
  await f.el('quoteButton').fire('click');
  assert.match(f.el('quoteResult').textContent, /暂未返回可识别/);
  assert.ok(!f.el('quoteResult').textContent.includes('¥0'));
  assert.equal(f.el('quoteButton').disabled, false);
});

test('quoting uses selected quantities and handles cents as local reference prices', async () => {
  const f = fixture(); await f.refresh();
  const snapshotCount = f.calls.snapshots.length;
  await f.el('quoteButton').fire('click');
  assert.deepEqual(f.calls.quotes[0], { storeCode: 'first', orderType: 1, beType: 1, items: [{ productCode: 'burger', quantity: 2 }, { productCode: 'nuggets', quantity: 1 }] });
  assert.match(f.el('quoteResult').textContent, /¥62\.00/);
  assert.equal(f.calls.snapshots.length, snapshotCount);
});

test('changing stores clears previous prices and invalidates an older pending menu', async () => {
  const pending = deferred();
  const f = fixture(); await f.refresh();
  f.api.loadMcpMenu = () => pending.promise;
  const sync = f.el('menuSyncButton').fire('click');
  f.el('storeSelect').value = 'second'; f.el('storeSelect').fire('change');
  assert.equal(f.calls.snapshots.at(-1), null);
  assert.equal(f.el('menuResults').children.length, 0);
  assert.equal(f.el('menuUpdatedAt').textContent, '');
  assert.match(f.el('menuStoreLabel').textContent, /第二/);
  pending.resolve(menuResponse); await sync;
  assert.equal(f.calls.snapshots.at(-1), null);
  assert.equal(f.el('menuResults').children.length, 0);
  assert.equal(f.el('menuSyncButton').disabled, false);
});

test('disconnect while searching discards late store responses before any menu call', async () => {
  const pending = deferred();
  const f = fixture({ loadMcpStores: () => pending.promise });
  const refresh = f.refresh();
  f.controller.setConnected(false);
  pending.resolve(response([{ storeCode: 'late', storeName: '旧请求门店', businessStatus: true }]));
  await refresh;
  assert.equal(f.calls.menus.length, 0);
  assert.equal(f.calls.snapshots.at(-1), null);
  assert.equal(f.el('storeSelect').children.length, 0);
  assert.equal(f.el('menuSyncButton').disabled, true);
  assert.match(f.el('menuMessage').textContent, /连接 MCP 后/);
});

test('disconnect while loading a menu prevents late snapshots and optional detail calls', async () => {
  const pending = deferred(); let waiting = false;
  const f = fixture({ loadMcpMenu: () => { waiting = true; return pending.promise; } });
  const refresh = f.refresh(); await tickUntil(() => waiting);
  f.controller.setConnected(false);
  pending.resolve(menuResponse); await refresh;
  assert.equal(f.calls.snapshots.filter(Boolean).length, 0);
  assert.equal(f.calls.details.length, 0);
  assert.equal(f.el('menuResults').children.length, 0);
});

test('a stale quote response or failure cannot overwrite disconnect or a new connection', async () => {
  for (const reject of [false, true]) {
    const pending = deferred();
    const f = fixture(); await f.refresh();
    f.api.loadMcpQuote = () => pending.promise;
    const quote = f.el('quoteButton').fire('click');
    f.controller.setConnected(false); f.controller.setConnected(true);
    await f.refresh();
    const currentMessage = f.el('menuMessage').textContent;
    if (reject) pending.reject(new Error('Old request failed')); else pending.resolve(response({ price: 100 }));
    await quote;
    assert.equal(f.el('quoteResult').textContent, '');
    assert.equal(f.el('menuMessage').textContent, currentMessage);
    assert.equal(f.calls.snapshots.at(-1).store.code, 'first');
  }
});

test('quote failures leave retryable controls and a settled result message', async () => {
  const f = fixture({ loadMcpQuote: async () => { throw new Error('Synthetic quote failure'); } }); await f.refresh();
  await f.el('quoteButton').fire('click');
  assert.match(f.el('quoteResult').textContent, /未完成/);
  assert.equal(f.el('quoteButton').disabled, false);
});

async function integratedFixture({ core = {}, price = {} } = {}) {
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  globalThis.document = { getElementById: el, createElement: () => new Element() };
  globalThis.location = { hostname: '127.0.0.1' };
  const calls = { nutrition: 0, disconnect: 0, stores: 0, details: 0, demo: 0, live: 0, snapshots: [] };
  const api = {
    getMcpStatus: async () => ({ state: 'connected' }),
    loadMcpNutrition: async () => { calls.nutrition += 1; return response({ items: [{ productName: '巨无霸' }, { productName: '麦乐鸡5块' }] }); },
    disconnectMcp: async () => { calls.disconnect += 1; return { state: 'needs-auth' }; },
    ...core,
  };
  const priceApi = {
    loadMcpStores: async () => { calls.stores += 1; return response([{ storeCode: 'first', storeName: '上海示例门店', businessStatus: true }]); },
    loadMcpMenu: async () => menuResponse,
    loadMcpMealDetail: async () => { calls.details += 1; return response({}); },
    loadMcpQuote: async () => response({ price: 2500 }),
    ...price,
  };
  const controller = setupMcpUI({ api, priceApi, onLive: () => calls.live += 1, onDemo: () => calls.demo += 1, onMenu: snapshot => calls.snapshots.push(snapshot), getSelection: () => ['bigmac'] });
  await controller.ready;
  return { el, calls, controller, api, priceApi };
}

test('manual price queries lock parent sync and disconnect until the shared bridge is free', async () => {
  const pending = deferred();
  const f = await integratedFixture({ price: { loadMcpStores: () => pending.promise } });
  const query = f.el('storeSearchForm').fire('submit');
  assert.equal(f.el('mcpSync').disabled, true);
  assert.equal(f.el('mcpDisconnect').disabled, true);
  assert.equal(f.el('mcpConnect').disabled, true);
  await f.el('mcpSync').fire('click'); await f.el('mcpDisconnect').fire('click');
  assert.equal(f.calls.nutrition, 0); assert.equal(f.calls.disconnect, 0);
  pending.resolve(response([])); await query;
  assert.equal(f.el('mcpSync').disabled, false);
  assert.equal(f.el('mcpDisconnect').disabled, false);
});

test('parent nutrition sync locks manual price calls and still completes its internal menu refresh', async () => {
  const pending = deferred();
  const f = await integratedFixture({ core: { loadMcpNutrition: () => pending.promise } });
  const sync = f.el('mcpSync').fire('click');
  assert.equal(f.el('storeSearchButton').disabled, true);
  await f.el('storeSearchForm').fire('submit');
  assert.equal(f.calls.stores, 0);
  pending.resolve(response({ items: [{ productName: '巨无霸' }] })); await sync;
  assert.equal(f.calls.stores, 1);
  assert.equal(f.calls.details, 2);
  assert.equal(f.calls.snapshots.at(-1).store.code, 'first');
  assert.equal(f.el('storeSearchButton').disabled, false);
  assert.equal(f.el('mcpSync').disabled, false);
});

test('detail authentication failure clears the parent live state and stops subsequent details', async () => {
  let detailCalls = 0;
  const expired = Object.assign(new Error('Synthetic expired authentication'), { code: 'needs-auth', state: 'needs-auth' });
  const f = await integratedFixture({ price: { loadMcpMealDetail: async () => { detailCalls += 1; throw expired; } } });
  await f.el('mcpSync').fire('click');
  assert.equal(detailCalls, 1);
  assert.equal(f.calls.live, 1); assert.equal(f.calls.demo, 1);
  assert.equal(f.calls.snapshots.at(-1), null);
  assert.match(f.el('mcpStatus').textContent, /等待首次授权/);
  assert.equal(f.el('storeSearchButton').disabled, true);
  assert.equal(f.el('mcpSync').disabled, true);
  assert.equal(f.el('mcpConnect').disabled, false);
});

test('manual quote authentication failures propagate to the parent connection state', async () => {
  const f = await integratedFixture(); await f.el('mcpSync').fire('click');
  f.priceApi.loadMcpQuote = async () => { throw Object.assign(new Error('Synthetic expired authentication'), { code: 'needs-auth', state: 'needs-auth' }); };
  await f.el('quoteButton').fire('click');
  assert.match(f.el('mcpStatus').textContent, /等待首次授权/);
  assert.equal(f.el('quoteButton').disabled, true);
  assert.equal(f.el('mcpSync').disabled, true);
  assert.equal(f.calls.snapshots.at(-1), null);
});

test('generic menu identities are resolved before publishing prices and reuse the detail requests', async () => {
  const details = [];
  const f = fixture({
    loadMcpMenu: async () => response({ meals: { '1401': { name: '麦乐鸡', currentPrice: '14' }, '4810': { name: '薯条', currentPrice: '13.5' } } }),
    loadMcpMealDetail: async args => { details.push(args.code); return response({ code: args.code, name: args.code === '1401' ? '麦乐鸡5块' : '中薯条', rounds: [] }); },
  });
  await f.refresh();
  assert.deepEqual(details, ['1401', '4810']);
  assert.deepEqual(f.calls.snapshots.filter(Boolean).map(snapshot => snapshot.products.map(item => item.packId)), [['nuggets', 'fries']]);
});

test('credentials close on connection changes while a manual expansion survives price controls', async () => {
  const f = await integratedFixture();
  assert.equal(f.el('mcpCredentials').open, false);
  f.el('mcpCredentials').open = true;
  await f.el('storeSearchForm').fire('submit');
  assert.equal(f.el('mcpCredentials').open, true);
  await f.el('mcpDisconnect').fire('click');
  assert.equal(f.el('mcpCredentials').open, true);
});
