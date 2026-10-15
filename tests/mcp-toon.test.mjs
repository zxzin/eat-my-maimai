import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNutritionToon, extractNutritionFoods, buildLiveLoadout } from '../src/mcp-loadout.js';

// Official public documentation section 4.2.1, retrieved 2026-10-14:
// https://open.mcd.cn/mcp/doc
// This is a documentation fixture, not an authenticated response receipt.
const officialToon = '[1]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  猪柳麦满分,null,1288,308,16,16,24,781,213\n ';
const officialEnvelope = { success: true, code: 200, message: '请求成功', datetime: '2026-01-23 09:32:44', data: officialToon };

test('official TOON documentation record parses through MCP text JSON envelope', () => {
  const result = { content: [{ type: 'text', text: JSON.stringify(officialEnvelope) }] };
  assert.deepEqual(extractNutritionFoods(result), [{ name: '猪柳麦满分' }]);
});

test('official TOON record works in structuredContent and a raw TOON text block', () => {
  assert.deepEqual(extractNutritionFoods({ structuredContent: officialEnvelope }), [{ name: '猪柳麦满分' }]);
  assert.deepEqual(extractNutritionFoods({ content: [{ type: 'text', text: officialToon }] }), [{ name: '猪柳麦满分' }]);
});

test('quoted fields and CRLF preserve the same official food identity', () => {
  const quoted = officialToon.replace('猪柳麦满分,null', '"猪柳麦满分","null"').replace(/\n/g, '\r\n');
  assert.deepEqual(parseNutritionToon(quoted), [{ productName: '猪柳麦满分' }]);
});

test('malformed or partial TOON never unlocks food', () => {
  const invalid = [
    officialToon.replace('[1]', '[2]'),
    officialToon.replace(',213', ''),
    officialToon.replace(',213', ',213,'),
    officialToon.replace('猪柳麦满分', '"猪柳麦满分'),
    officialToon.replace('nutritionDescription', 'productName'),
    officialToon.replace('productName', 'description'),
    `餐品介绍\n${officialToon}`,
    officialToon.replace('猪柳麦满分', 'null'),
  ];
  for (const value of invalid) assert.deepEqual(parseNutritionToon(value), []);
});

test('TOON parser enforces input size and row limits', () => {
  assert.deepEqual(parseNutritionToon(officialToon + ' '.repeat(512 * 1024)), []);
  assert.deepEqual(parseNutritionToon(officialToon.replace('[1]', '[2001]')), []);
});

test('MCP and business error envelopes cannot unlock official fixture food', () => {
  assert.deepEqual(extractNutritionFoods({ isError: true, structuredContent: officialEnvelope }), []);
  assert.deepEqual(extractNutritionFoods({ structuredContent: { ...officialEnvelope, success: false } }), []);
});

test('TOON-derived matching preserves exact product identity and nutrition-only source', () => {
  const catalog = [
    { id: 'sausage-muffin', name: '猪柳麦满分', cost: 10, ability: 'game-rule' },
    { id: 'bigmac', name: '巨无霸', cost: 14 },
  ];
  const result = buildLiveLoadout({ structuredContent: officialEnvelope }, catalog, '2026-10-14T00:00:00.000Z');
  assert.deepEqual(result.matched.map(row => row.id), ['sausage-muffin']);
  assert.deepEqual(result.unmatched, ['bigmac']);
  assert.equal(result.matched[0].cost, 10);
  assert.equal(result.matched[0].source.availability, 'nutrition-catalog-only');
  assert.equal(result.matched[0].source.priceMode, 'fictional-supply-points');
  assert.equal(result.matched[0].source.productName, '猪柳麦满分');
});
