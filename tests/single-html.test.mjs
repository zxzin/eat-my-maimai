import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeInlineScript, sanitizePublicSnapshot, renderSingleHtml } from '../scripts/build-single-html.mjs';

const template = '<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head><body><dialog id="dataDialog"><input id="mcpToken" type="password"></dialog><script type="module" src="/src/main.js"></script></body></html>';

test('single HTML contains its script and stylesheet without account controls or source requests', () => {
  const html = renderSingleHtml(template, 'window.ready=true;', 'body{margin:0}');
  assert.match(html, /<style>body\{margin:0\}<\/style>/);
  assert.match(html, /window.ready=true/);
  assert.match(html, /离线试玩/);
  assert.doesNotMatch(html, /mcpToken|type="password"|\/src\/|script type="module"/);
});

test('public snapshot whitelist discards account and raw MCP response fields', () => {
  const clean = sanitizePublicSnapshot({ retrievedAt: '2026-10-15T00:00:00Z', token: 'not-a-real-token', store: { city: '上海', name: '示例门店', memberId: 'private' }, raw: { authorization: 'private' }, products: [{ packId: 'bigmac', name: '巨无霸', publicPriceYuan: 27.5, token: 'private' }, { packId: 'bigmac', name: '重复', publicPriceYuan: 9 }, { packId: '../invalid', name: '无效' }] });
  assert.equal(clean.products.length, 1);
  assert.equal(clean.products[0].publicPriceYuan, 27.5);
  assert.equal(clean.store.city, '上海');
  assert.doesNotMatch(JSON.stringify(clean), /token|private|authorization|raw|memberId/);
});

test('snapshot script content cannot end the inline script', () => {
  const snapshot = sanitizePublicSnapshot({ products: [{ packId: 'bigmac', name: '</script><script>bad()</script>', publicPriceYuan: -1 }] });
  assert.equal(snapshot.products[0].publicPriceYuan, null);
  const html = renderSingleHtml(template, 'window.ready=true;', '', snapshot);
  assert.equal((html.match(/<\/script>/gi) || []).length, 1);
  assert.doesNotMatch(escapeInlineScript('<!--</ScRiPt>'), /<!--|<\/script/i);
});

test('builder fails closed for a live MCP client or external resource', () => {
  assert.throws(() => renderSingleHtml(template, 'fetch("/api/mcp/status")', ''), /MCP API/);
  assert.throws(() => renderSingleHtml(template.replace('</body>', '<img src="https://example.test/a.png"></body>'), '', ''), /外部运行资源/);
});

test('inline resources and dynamic canvas thumbnails stay self-contained', () => {
  const html = renderSingleHtml(template, 'const markup = `<img src="${canvas.toDataURL()}">`;', 'body{background:url("data:image/png;base64,AA==")}');
  assert.match(html, /canvas.toDataURL/);
  assert.match(html, /connect-src 'none'/);
  assert.throws(() => renderSingleHtml(template, '', 'body{background:url(https://example.test/a.png)}'), /外部运行资源/);
});

test('nutrition-only public snapshots preserve verified identities without making up prices', () => {
  const snapshot = sanitizePublicSnapshot({ nutrition: { retrievedAt: '2026-10-15T00:00:00Z', foodCount: 158, matchedIds: ['bigmac', 'bigmac', '../bad'] }, products: [] });
  assert.deepEqual(snapshot.nutrition.matchedIds, ['bigmac']);
  assert.equal(snapshot.retrievedAt, null);
  assert.deepEqual(snapshot.products, []);
});
