import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStageHit, isStageComplete } from '../src/stage-rules.js';

const nodes = [
  { id: 'valve', ingredient: 'ketchup', x: 0, y: 2, z: 1 },
  { id: 'food', ingredient: 'nugget', x: 3, y: 1, z: 1 },
  { id: 'fan', ingredient: 'fry', x: 4, y: 3, z: 1 },
  { id: 'blade', ingredient: 'fry', x: 5, y: 3, z: 1 },
];
const mechanisms = [
  { id: 'sauce', label: '酱料泵', triggerIds: ['valve'], memberIds: ['valve', 'food', 'fan'], cleared: false },
  { id: 'fries', label: '薯条塔', triggerIds: ['fan'], memberIds: ['fan', 'blade'], cleared: false },
];

test('matching a real trigger releases its food and propagates a deduplicated chain', () => {
  const result = resolveStageHit({ ammo: 'ketchup', target: nodes[0], neighbors: nodes, setpieces: mechanisms });
  assert.deepEqual(result.setpieceIds, ['sauce', 'fries']);
  assert.deepEqual(result.removeIds, ['valve', 'food', 'fan', 'blade']);
  assert.equal(nodes.some(node => node.removed), false);
  assert.equal(mechanisms.some(item => item.cleared), false);
});

test('wrong ammunition cannot activate a nearby mechanism', () => {
  const result = resolveStageHit({ ammo: 'onion', target: nodes[0], neighbors: nodes, setpieces: mechanisms });
  assert.deepEqual(result.removeIds, []);
  assert.deepEqual(result.setpieceIds, []);
});

test('corn opens a mechanism on its eighth hit and preserves intermediate damage',()=>{
  const chipped=resolveStageHit({ammo:'corn',target:{...nodes[0],cornHp:2},neighbors:nodes,setpieces:mechanisms});
  assert.equal(chipped.type,'chip');
  assert.deepEqual(chipped.damage,[{id:'valve',amount:1,remaining:1}]);
  assert.deepEqual(chipped.removeIds,[]);assert.deepEqual(chipped.setpieceIds,[]);
  const final=resolveStageHit({ammo:'corn',target:{...nodes[0],cornHp:1},neighbors:nodes,setpieces:mechanisms});
  assert.deepEqual(final.damage,[{id:'valve',amount:1,remaining:0}]);
  assert.deepEqual(final.removeIds,['valve','food','fan','blade']);
  assert.deepEqual(final.setpieceIds,['sauce','fries']);
});

test('cleared mechanisms and removed members cannot pay out twice', () => {
  const result = resolveStageHit({ ammo: 'ketchup', target: nodes[0], neighbors: nodes.map(node => ({ ...node, removed: node.id === 'food' })), setpieces: mechanisms.map(item => ({ ...item, cleared: item.id === 'fries' })) });
  assert.deepEqual(result.setpieceIds, ['sauce']);
  assert.deepEqual(result.removeIds, ['valve', 'fan']);
});

test('victory requires the clear threshold and all three objectives', () => {
  assert.equal(isStageComplete(40, 30, mechanisms), false);
  assert.equal(isStageComplete(20, 30, mechanisms.map(item => ({ ...item, cleared: true }))), false);
  assert.equal(isStageComplete(40, 30, mechanisms.map(item => ({ ...item, cleared: true }))), true);
  assert.equal(isStageComplete(40, 30, []), false);
});
