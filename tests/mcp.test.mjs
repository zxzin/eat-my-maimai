import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { McdMcpConnection, MCP_ENDPOINT, validateArguments } from '../server/mcd-mcp.js';
import { assertLocalRequest, createMcpMiddleware, mcpPlugin } from '../server/mcp-vite-plugin.js';
import { buildLiveLoadout, extractNutritionFoods } from '../src/mcp-loadout.js';

const nutritionTool = { name: 'list-nutrition-foods', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
const menuTool = { name: 'query-meals', inputSchema: { type: 'object', properties: { storeCode: { type: 'string' } }, required: ['storeCode'], additionalProperties: false } };
const storesTool = { name: 'query-nearby-stores', inputSchema: { type: 'object', properties: { searchType: { type: 'integer', enum: [1, 2, 3] }, beType: { type: 'integer', enum: [1, 5] }, city: { type: 'string', minLength: 2 }, keyword: { type: 'string', maxLength: 30 } }, required: ['searchType', 'beType'], additionalProperties: false } };

function fixture({ sse = false, failure = null, paginated = false, withStores = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const message = JSON.parse(options.body);
    requests.push({ url, options, message });
    if (failure) return new Response('private upstream details', { status: failure });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    if (message.method === 'tools/list') result = message.params.cursor
      ? { tools: [menuTool] }
      : { tools: [nutritionTool, { name: 'create-order', inputSchema: { type: 'object' } }, ...(withStores ? [storesTool] : []), ...(paginated ? [] : [menuTool])], ...(paginated ? { nextCursor: 'second' } : {}) };
    if (message.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ data: [{ productName: '巨无霸' }, { productName: '小薯条' }] }) }] };
    const rpc = { jsonrpc: '2.0', id: message.id, result };
    const headers = { 'Content-Type': sse ? 'text/event-stream' : 'application/json', ...(message.method === 'initialize' ? { 'Mcp-Session-Id': 'fixture-session' } : {}) };
    if (!sse) return new Response(JSON.stringify(rpc), { headers });
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'));
      controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`));
      // Stay open after a matching event: the client must return and cancel it.
    } });
    return new Response(stream, { headers });
  };
  const connection = new McdMcpConnection({ fetchImpl, getEnvironmentToken: () => '' });
  return { requests, connection };
}

test('missing credentials reports needs-auth without contacting official service', async () => {
  const { connection, requests } = fixture();
  assert.equal(connection.status().state, 'needs-auth');
  await assert.rejects(connection.connect(), { code: 'needs-auth' });
  assert.equal(requests.length, 0);
});

test('connect follows initialize → initialized → live tools/list and carries session', async () => {
  const { connection, requests } = fixture({ paginated: true });
  const state = await connection.connect('fixture-token');
  assert.equal(state.state, 'connected');
  assert.equal(state.busy, false);
  assert.deepEqual(requests.map(entry => entry.message.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
  assert.ok(requests.every(entry => entry.url === MCP_ENDPOINT));
  assert.ok(requests.every(entry => entry.options.redirect === 'error'));
  assert.equal(requests[1].options.headers['Mcp-Session-Id'], 'fixture-session');
  assert.equal(requests[2].options.headers.Authorization, 'Bearer fixture-token');
  assert.equal(requests[2].options.headers.Accept, 'application/json, text/event-stream');
  assert.deepEqual(state.tools.map(tool => tool.name), ['list-nutrition-foods', 'query-meals']);
  assert.ok(!JSON.stringify(state).includes('fixture-token'));
  assert.ok(!JSON.stringify(state).includes('fixture-session'));
});

test('SSE responses complete on matching result without waiting for stream closure', async () => {
  const { connection } = fixture({ sse: true });
  await connection.connect('fixture-token');
  const response = await connection.call('list-nutrition-foods');
  assert.equal(response.tool, 'list-nutrition-foods');
  assert.equal(extractNutritionFoods(response.result).length, 2);
});

test('mutation tools are blocked and live inputSchema is used before any call', async () => {
  const { connection, requests } = fixture();
  await connection.connect('fixture-token');
  const count = requests.length;
  await assert.rejects(connection.call('create-order', {}), { code: 'forbidden-tool' });
  await assert.rejects(connection.call('query-meals', {}), { code: 'invalid-arguments' });
  await assert.rejects(connection.call('query-meals', { storeCode: 10 }), { code: 'invalid-arguments' });
  await assert.rejects(connection.call('query-meals', { storeCode: 'fixture-store', invented: 1 }), { code: 'invalid-arguments' });
  assert.equal(requests.length, count);
  await connection.call('query-meals', { storeCode: 'fixture-store' });
  assert.deepEqual(requests.at(-1).message.params, { name: 'query-meals', arguments: { storeCode: 'fixture-store' } });
});

test('public store discovery must pass both scope restrictions and live schema before upstream use', async () => {
  const { connection, requests } = fixture({ withStores: true });
  await connection.connect('fixture-token');
  assert.ok(connection.status().tools.some(tool => tool.name === 'query-nearby-stores'));
  const count = requests.length;
  await assert.rejects(connection.call('query-nearby-stores', { searchType: 1, beType: 1 }), { code: 'query-scope' });
  await assert.rejects(connection.call('query-nearby-stores', { searchType: 2, beType: 1, city: '上海市', keyword: 'x'.repeat(31) }), { code: 'invalid-arguments' });
  assert.equal(requests.length, count);
  const args = { searchType: 2, beType: 1, city: '上海市', keyword: '人民广场' };
  await connection.call('query-nearby-stores', args);
  assert.deepEqual(requests.at(-1).message.params, { name: 'query-nearby-stores', arguments: args });
});

test('authentication rejection is truthful and upstream response body stays private', async () => {
  const { connection } = fixture({ failure: 403 });
  await assert.rejects(connection.connect('fixture-token'), error => error.code === 'needs-auth' && !error.message.includes('private'));
  assert.equal(connection.status().state, 'needs-auth');
  assert.deepEqual(connection.status().tools, []);
});

test('network failures report unavailable and never claim connection', async () => {
  const connection = new McdMcpConnection({ fetchImpl: async () => { throw new Error('sensitive network error'); }, getEnvironmentToken: () => '' });
  await assert.rejects(connection.connect('fixture-token'), { code: 'unavailable' });
  assert.equal(connection.status().state, 'unavailable');
  assert.ok(!connection.status().message.includes('sensitive'));
});

test('disconnect removes session capability and requires explicit reconnect', async () => {
  const { connection, requests } = fixture();
  await connection.connect('fixture-token');
  const count = requests.length;
  const state = connection.disconnect();
  assert.equal(state.state, 'needs-auth');
  assert.equal(state.connectedAt, null);
  assert.deepEqual(state.tools, []);
  await assert.rejects(connection.call('list-nutrition-foods'), { code: 'needs-auth' });
  assert.equal(requests.length, count);
});

test('server environment credential stays in server requests and is never returned', async () => {
  const { connection, requests } = fixture();
  connection.getEnvironmentToken = () => 'fixture-env-token';
  assert.equal(connection.status().hasServerCredential, true);
  const state = await connection.connect();
  assert.ok(!JSON.stringify(state).includes('fixture-env-token'));
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-env-token');
});

test('schema checks nested required values, choices and number constraints', () => {
  const schema = { type: 'object', properties: { items: { type: 'array', minItems: 1, items: { $ref: '#/$defs/item' } } }, required: ['items'], $defs: { item: { type: 'object', properties: { count: { type: 'integer', minimum: 1 }, variant: { enum: ['small', 'large'] } }, required: ['count'] } } };
  assert.deepEqual(validateArguments({ items: [{ count: 2, variant: 'small' }] }, schema), []);
  assert.ok(validateArguments({ items: [{ count: 0, variant: 'invented' }] }, schema).length === 2);
});

test('loopback Host and same Origin are required for credential requests', () => {
  const request = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:5178', origin: 'http://127.0.0.1:5178' } };
  assert.doesNotThrow(() => assertLocalRequest(request));
  for (const headers of [
    { host: 'attacker.test', origin: 'http://attacker.test' },
    { host: '127.0.0.1:5178', origin: 'https://attacker.test' },
    { host: '127.0.0.1:5178' },
    { host: 'localhost:5178', origin: 'http://localhost:5178', 'sec-fetch-site': 'cross-site' },
  ]) assert.throws(() => assertLocalRequest({ method: 'POST', socket: request.socket, headers }), { code: 'forbidden-origin' });
  assert.throws(() => assertLocalRequest({ ...request, socket: { remoteAddress: '192.168.1.20' } }), { code: 'forbidden-origin' });
});

async function localRequest(middleware, path, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  const req = Readable.from([text]);
  req.url = path;
  req.method = 'POST';
  req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { host: '127.0.0.1:5178', origin: 'http://127.0.0.1:5178', 'content-type': 'application/json', ...extraHeaders };
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = { setHeader: (key, value) => { headers[key] = value; }, end: value => resolve({ status: res.statusCode, headers, data: JSON.parse(value) }) };
    middleware(req, res, () => reject(new Error('Unexpected fallthrough'))).catch(reject);
  });
}

test('middleware rejects foreign origins and oversized input without connecting', async () => {
  const { connection, requests } = fixture();
  const middleware = createMcpMiddleware(connection);
  const crossOrigin = await localRequest(middleware, '/api/mcp/connect', { token: 'fixture-token' }, { origin: 'https://attacker.test' });
  assert.equal(crossOrigin.status, 403);
  const oversized = await localRequest(middleware, '/api/mcp/connect', { token: 'x'.repeat(70000) });
  assert.equal(oversized.status, 413);
  assert.equal(requests.length, 0);
  assert.equal(crossOrigin.headers['Cache-Control'], 'no-store');
});

test('middleware connects, calls nutrition, and rejects mutations', async () => {
  const { connection } = fixture();
  const middleware = createMcpMiddleware(connection);
  assert.equal((await localRequest(middleware, '/api/mcp/connect', { token: 'fixture-token' })).status, 200);
  const nutrition = await localRequest(middleware, '/api/mcp/nutrition', {});
  assert.equal(nutrition.status, 200);
  assert.equal(nutrition.data.tool, 'list-nutrition-foods');
  assert.equal((await localRequest(middleware, '/api/mcp/call', { name: 'auto-bind-coupons', arguments: {} })).status, 403);
});

test('Vite permits LAN game hosting while the MCP middleware validates peers', () => {
  const plugin = mcpPlugin();
  const middleware = [];
  const server = { config: { server: { host: '0.0.0.0' }, preview: { host: '0.0.0.0' } }, middlewares: { use: value => middleware.push(value) } };
  plugin.configureServer(server);
  plugin.configurePreviewServer(server);
  assert.equal(middleware.length, 2);
});

test('live mapping uses exact food records and never treats nutrition as store inventory', () => {
  const result = { structuredContent: { data: [{ productName: '巨无霸' }, { productName: '小薯条' }] } };
  const catalog = [
    { id: 'bigmac', name: '巨无霸', cost: 14, ability: 'heavy' },
    { id: 'fries', name: '中薯条', cost: 8 },
    { id: 'mini', name: '小薯条', cost: 6 },
  ];
  const loadout = buildLiveLoadout(result, catalog, '2026-10-14T00:00:00.000Z');
  assert.deepEqual(loadout.matched.map(ammo => ammo.id), ['bigmac', 'mini']);
  assert.deepEqual(loadout.unmatched, ['fries']);
  assert.equal(loadout.matched[0].cost, 14);
  assert.equal(loadout.matched[0].ability, 'heavy');
  assert.equal(loadout.matched[0].source.availability, 'nutrition-catalog-only');
  assert.equal(loadout.matched[0].source.priceMode, 'fictional-supply-points');
  assert.equal(loadout.matched[0].source.retrievedAt, '2026-10-14T00:00:00.000Z');
});

test('text mentions, unsupported formatting and isError results unlock no products', () => {
  assert.deepEqual(extractNutritionFoods({ content: [{ type: 'text', text: '巨无霸与中薯条' }] }), []);
  assert.deepEqual(extractNutritionFoods({ isError: true, structuredContent: { name: '巨无霸' } }), []);
  assert.deepEqual(buildLiveLoadout({ content: [] }, [{ id: 'burger', name: '巨无霸' }]).matched, []);
});
