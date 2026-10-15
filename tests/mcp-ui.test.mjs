import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMcpUI } from '../src/mcp-ui.js';

class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = true;
    this.children = []; this.handlers = {};
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  replaceChildren(...children) { this.children = children; }
  append(child) { this.children.push(child); }
  fire(name) { return this.handlers[name]?.({ preventDefault() {} }); }
}
function fixture(apiOverrides = {}, hostname = '127.0.0.1') {
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  globalThis.document = { getElementById: el, createElement: () => new Element() };
  globalThis.location = { hostname };
  const calls = { demo: 0, live: [], connect: [] };
  const nutrition = { state: 'connected', retrievedAt: '2026-10-14T00:00:00.000Z', result: { structuredContent: { items: [{ productName: '巨无霸' }] } } };
  const api = {
    getMcpStatus: async () => ({ state: 'needs-auth', hasServerCredential: false, message: '等待授权' }),
    connectMcp: async token => { calls.connect.push(token); return { state: 'connected' }; },
    loadMcpNutrition: async () => nutrition,
    disconnectMcp: async () => ({ state: 'needs-auth' }),
    ...apiOverrides,
  };
  const controller = setupMcpUI({ api, onLive: rows => calls.live.push(rows), onDemo: () => { calls.demo += 1; } });
  const connect = async () => { el('mcpToken').value = 'synthetic-ui-fixture'; await el('mcpForm').fire('submit'); };
  return { el, calls, api, controller, connect, nutrition };
}
function failure(state, code = state) { const error = new Error('合成失败'); error.state = state; error.code = code; return error; }

// All credentials and official responses in these tests are synthetic.
// No real browser, network, local credential files, or official account is used.
test('sync exposes only current product packs and matches the official five-nugget name', async () => {
  const names = ['巨无霸', '麦辣鸡腿汉堡', '麦乐鸡5块', '中薯条', '可乐中杯', '奥利奥麦旋风', '麦香鱼', '小薯条', '麦乐鸡4块'];
  const f = fixture({ loadMcpNutrition: async () => ({
    state: 'connected',
    result: { structuredContent: { items: names.map(productName => ({ productName })) } },
  }) });
  await f.controller.ready; await f.connect();
  assert.equal(f.calls.live.length, 1);
  assert.deepEqual(f.calls.live[0].map(pack => pack.id), ['bigmac', 'spicy', 'nuggets', 'fries', 'fish']);
  assert.equal(f.calls.live[0].find(pack => pack.id === 'nuggets').source.productName, '麦乐鸡5块');
  assert.deepEqual(f.el('mcpFoods').children.map(child => child.textContent), ['巨无霸', '麦辣鸡腿汉堡', '五块麦乐鸡', '中薯条', '麦香鱼']);
  assert.equal(f.el('mcpBadge').textContent, 'MCP 配装餐品 · 5 款');
  assert.match(f.el('mcpMessage').textContent, /官方餐品目录 9 项，匹配 5 款可配装餐品/);
});

test('successful sync followed by failed reconnect returns demo and honest needs-auth state', async () => {
  const f = fixture(); await f.controller.ready; await f.connect();
  assert.equal(f.calls.live.length, 1);
  assert.equal(f.el('dataButton').classList.contains('connected'), true);
  f.api.connectMcp = async () => { throw failure('needs-auth'); };
  await f.connect();
  assert.equal(f.calls.demo, 1);
  assert.equal(f.el('dataButton').classList.contains('connected'), false);
  assert.equal(f.el('mcpFoods').hidden, true);
  assert.equal(f.el('mcpFoods').children.length, 0);
  assert.equal(f.el('mcpBadge').textContent, '连接麦当劳 MCP');
  assert.equal(f.el('mcpSync').disabled, true);
  assert.equal(f.el('mcpDisconnect').disabled, true);
  assert.match(f.el('mcpMessage').textContent, /官方授权页面/);
});

test('empty or unrecognized nutrition clears prior live badge while retaining valid connection', async () => {
  const f = fixture(); await f.controller.ready; await f.connect();
  f.api.loadMcpNutrition = async () => ({ state: 'connected', result: { content: [{ type: 'text', text: 'unrecognized data' }] } });
  await f.el('mcpSync').fire('click');
  assert.equal(f.calls.demo, 1);
  assert.equal(f.el('dataButton').classList.contains('connected'), false);
  assert.equal(f.el('mcpFoods').hidden, true);
  assert.equal(f.el('mcpBadge').textContent, '连接麦当劳 MCP');
  assert.equal(f.el('mcpSync').disabled, false);
  assert.match(f.el('mcpMessage').textContent, /营养目录不代表门店库存/);
});

test('token input clears synchronously before pending network operation completes', async () => {
  let release;
  const f = fixture({ connectMcp: () => new Promise(resolve => { release = resolve; }) });
  await f.controller.ready;
  f.el('mcpToken').value = 'synthetic-ui-fixture';
  const pending = f.el('mcpForm').fire('submit');
  assert.equal(f.el('mcpToken').value, '');
  assert.equal(f.el('mcpConnect').disabled, true);
  release({ state: 'connected' }); await pending;
  assert.equal(f.el('mcpConnect').disabled, false);
  assert.equal(f.calls.live.length, 1);
});

test('nutrition failure retains only an explicitly valid server connection and permits retry', async () => {
  const f = fixture(); await f.controller.ready; await f.connect();
  f.api.loadMcpNutrition = async () => { throw failure('connected', 'tool-error'); };
  await f.el('mcpSync').fire('click');
  assert.equal(f.calls.demo, 1);
  assert.equal(f.el('mcpSync').disabled, false);
  assert.equal(f.el('mcpDisconnect').disabled, false);
  assert.match(f.el('mcpStatus').textContent, /同步未完成/);
  f.api.loadMcpNutrition = async () => f.nutrition;
  await f.el('mcpSync').fire('click');
  assert.equal(f.calls.live.length, 2);
  assert.equal(f.el('dataButton').classList.contains('connected'), true);
});

test('slow initial status cannot overwrite successful user connection and sync', async () => {
  let release;
  const f = fixture({ getMcpStatus: () => new Promise(resolve => { release = resolve; }) });
  await f.connect();
  release({ state: 'needs-auth', message: 'old initial response' }); await f.controller.ready;
  assert.match(f.el('mcpStatus').textContent, /已同步/);
  assert.equal(f.el('mcpSync').disabled, false);
  assert.equal(f.calls.demo, 0);
});

test('LAN mode blocks credential submission and performs no MCP calls', async () => {
  let requested = false;
  const f = fixture({ getMcpStatus: async () => { requested = true; } }, '192.168.1.2');
  await f.controller.ready;
  assert.equal(requested, false);
  assert.equal(f.el('mcpToken').disabled, true);
  assert.equal(f.el('mcpConnect').disabled, true);
  await f.connect();
  assert.equal(f.calls.connect.length, 0);
  assert.match(f.el('mcpStatus').textContent, /演示模式/);
});

test('initial unavailable state remains a service failure instead of implying missing authorization', async () => {
  const f = fixture({ getMcpStatus: async () => ({ state: 'unavailable', message: '合成网络不可用' }) });
  await f.controller.ready;
  assert.equal(f.el('mcpStatus').textContent, '官方连接暂时不可用');
  assert.equal(f.el('mcpSync').disabled, true);
  assert.equal(f.el('mcpMessage').textContent, '合成网络不可用');
});
