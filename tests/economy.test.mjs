import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PACK_IDS, PACKS, buildInventory, consumeShot } from '../src/ingredient-rules.js';
import { START_COINS, createEconomy, earnCoins, payLoadout, purchasePack, canRestock } from '../src/economy.js';

const freezeState = state => Object.freeze({ ...state, rewardedIds: Object.freeze([...state.rewardedIds]) });
const zeroInventory = () => buildInventory([]).inventory;

test('initial loadout spends coins once and preserves wallet input', () => {
  const state = freezeState(createEconomy());
  assert.equal(state.coins, START_COINS);
  const paid = payLoadout(state, DEFAULT_PACK_IDS);
  assert.equal(paid.ok, true);
  assert.equal(paid.spent, 56);
  assert.deepEqual(paid.state, { coins: 4, earned: 0, spent: 56, rewardedIds: [] });
  assert.deepEqual(paid.inventory, buildInventory(DEFAULT_PACK_IDS).inventory);
  assert.deepEqual(state, createEconomy());
  assert.notEqual(paid.state.rewardedIds, state.rewardedIds);
});

test('cleared blocks earn once across duplicate contacts and combo replays', () => {
  const initial = freezeState(createEconomy(4));
  const first = earnCoins(initial, Object.freeze(['wall-a', 'wall-b', 'wall-a']), { combo: true });
  assert.equal(first.earned, 9);
  assert.deepEqual(first.state, { coins: 13, earned: 9, spent: 0, rewardedIds: ['wall-a', 'wall-b'] });
  const replay = earnCoins(freezeState(first.state), ['wall-a', 'wall-b'], { combo: true });
  assert.equal(replay.earned, 0);
  assert.deepEqual(replay.state, first.state);
  const next = earnCoins(first.state, ['wall-b', 'wall-c', 'wall-c'], { combo: true });
  assert.equal(next.earned, 6);
  assert.deepEqual(next.state.rewardedIds, ['wall-a', 'wall-b', 'wall-c']);
  assert.deepEqual(initial, createEconomy(4));
});

test('ordinary and bomb eliminations receive the same per-block reward', () => {
  const result = earnCoins(createEconomy(0), [0, 'block', null, undefined, '', NaN, {}, 0]);
  assert.equal(result.earned, 6);
  assert.deepEqual(result.state.rewardedIds, [0, 'block']);
  assert.equal(earnCoins(result.state, [], { combo: true }).earned, 0);
  assert.equal(earnCoins(result.state, null, { combo: true }).earned, 0);
  assert.equal(earnCoins(result.state, ['new'], { combo: 'true' }).earned, 3);
});

test('eliminate, spend, and fire keeps a conserved coin and inventory ledger', () => {
  const paid = payLoadout(createEconomy(), DEFAULT_PACK_IDS);
  const reward = earnCoins(paid.state, ['a', 'b'], { combo: true });
  const fired = consumeShot(paid.inventory, 'fry');
  const purchase = purchasePack(reward.state, Object.freeze(fired.inventory), { id: 'fries' });
  assert.equal(purchase.ok, true);
  assert.equal(purchase.state.coins, 3);
  assert.equal(purchase.state.earned, 9);
  assert.equal(purchase.state.spent, 66);
  assert.equal(START_COINS + purchase.state.earned - purchase.state.spent, purchase.state.coins);
  assert.equal(purchase.inventory.fry, 11);
  assert.equal(purchase.inventory.ketchup, 5);
  assert.equal(purchase.inventory.burgerbomb, 1);
  assert.equal(fired.inventory.fry, 5);
  assert.equal(canRestock(purchase.state), false);
});

test('whole burgers and ingredient packs use one canonical purchase conversion', () => {
  const first = purchasePack(createEconomy(), zeroInventory(), { id: 'bigmac', mode: 'whole', quantity: 2 });
  assert.equal(first.ok, true);
  assert.equal(first.spent, 36);
  assert.equal(first.inventory.burgerbomb, 2);
  assert.equal(first.inventory.bun, 0);
  const second = purchasePack(first.state, first.inventory, { id: 'bigmac' });
  assert.equal(second.ok, true);
  assert.equal(second.inventory.burgerbomb, 2);
  assert.equal(second.inventory.bun, 2);
  assert.equal(second.state.coins, 6);
  for (const id of ['fries', 'nuggets']) {
    const invalid = purchasePack(createEconomy(), zeroInventory(), { id, mode: 'whole' });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.spent, 0);
  }
});

test('invalid, disallowed and overdrawn purchases are atomic', () => {
  const state = freezeState(createEconomy(20));
  const inventory = Object.freeze({ ...zeroInventory(), bun: 2 });
  const cases = [
    { id: 'unknown' }, { id: 'fries', mode: 'both' }, { id: 'fries', quantity: 0 },
    { id: 'fries', quantity: -1 }, { id: 'fries', quantity: 1.5 }, { id: 'fries', quantity: 7 },
    { id: 'fries', quantity: Infinity }, { id: 'fries', quantity: 3 },
    { id: 'fries', allowedPackIds: [] }, { id: 'fries', allowedPackIds: ['bigmac'] },
    { id: 'fries', allowedPackIds: 'fries' },
  ];
  for (const request of cases) {
    const result = purchasePack(state, inventory, request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.state, state);
    assert.equal(result.inventory, inventory);
    assert.equal(result.spent, 0);
    assert.ok(Object.values(result.added).every(count => count === 0));
    assert.ok(result.error);
  }
  assert.match(purchasePack(state, inventory, { id: 'fries', quantity: 3 }).error, /还差 10 金币/);
  assert.equal(purchasePack(state, inventory, { id: 'fries', allowedPackIds: new Set(['fries']) }).ok, true);
  assert.equal(purchasePack(state, inventory, { id: 'fries', allowedPackIds: null }).ok, true);
});

test('preparation uses source eligibility and rejects empty or invalid selections', () => {
  const state = freezeState(createEconomy());
  for (const [selection, allowedPackIds] of [[[], undefined], [null, undefined], [['unknown'], undefined], [DEFAULT_PACK_IDS, ['fries']]]) {
    const result = payLoadout(state, selection, { allowedPackIds });
    assert.equal(result.ok, false);
    assert.equal(result.state, state);
    assert.equal(result.spent, 0);
    assert.ok(Object.values(result.inventory).every(count => count === 0));
  }
  assert.equal(payLoadout(state, ['fries'], { allowedPackIds: ['fries'] }).ok, true);
});

test('restock eligibility follows actual coin balance and the active menu', () => {
  const empty = zeroInventory();
  assert.equal(canRestock(createEconomy(0)), false);
  assert.equal(canRestock(createEconomy(9)), false);
  assert.equal(canRestock(createEconomy(10)), true);
  assert.equal(canRestock(createEconomy(10), ['nuggets']), false);
  assert.equal(canRestock(createEconomy(12), new Set(['nuggets'])), true);
  assert.equal(canRestock(createEconomy(), []), false);
  assert.equal(canRestock(createEconomy(), {}), false);
  for (const pack of PACKS) {
    const state = createEconomy(pack.cost);
    assert.equal(canRestock(state, [pack.id]), true);
    const purchase = purchasePack(state, empty, { id: pack.id, allowedPackIds: [pack.id] });
    assert.equal(purchase.ok, true);
    assert.equal(purchase.state.coins, 0);
  }
});

test('unsafe arithmetic and malformed inventory cannot change funds', () => {
  for (const start of [-1, 2.5, Infinity, '60']) assert.throws(() => createEconomy(start), RangeError);
  const maximum = createEconomy(Number.MAX_SAFE_INTEGER);
  assert.deepEqual(earnCoins(maximum, ['a']), { state: maximum, earned: 0 });
  const state = createEconomy();
  for (const inventory of [null, [], { bun: -1 }, { bun: .5 }, { laser: 1 }, { fry: Number.MAX_SAFE_INTEGER }]) {
    const result = purchasePack(state, inventory, { id: 'fries' });
    assert.equal(result.ok, false);
    assert.equal(result.state, state);
    assert.equal(result.inventory, inventory);
  }
  const capped = { ...state, spent: Number.MAX_SAFE_INTEGER };
  assert.equal(purchasePack(capped, zeroInventory(), { id: 'fries' }).ok, false);
});
