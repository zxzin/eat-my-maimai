import { INGREDIENTS, PACKS, MAX_PACKS, buildInventory } from './ingredient-rules.js';

// Coins belong to this game round. Product eligibility comes from the current
// menu; ingredient portions and coin prices use the authored game rules.
export const START_COINS = 60;
export const COINS_PER_BLOCK = 3;
export const COMBO_BONUS = 3;

const ingredientIds = new Set(INGREDIENTS.map(({ id }) => id));
const packById = new Map(PACKS.map(pack => [pack.id, pack]));
const emptyInventory = () => Object.fromEntries(INGREDIENTS.map(({ id }) => [id, 0]));
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const validNodeId = value => typeof value === 'string' ? value.length > 0 : typeof value === 'number' && Number.isFinite(value);
const validState = state => !!state && [state.coins, state.earned, state.spent].every(validCount)
  && Array.isArray(state.rewardedIds) && state.rewardedIds.every(validNodeId);

function menuAccess(allowedPackIds) {
  if (allowedPackIds === undefined || allowedPackIds === null) return { ok: true, ids: null };
  if (!Array.isArray(allowedPackIds) && !(allowedPackIds instanceof Set)) return { ok: false, ids: null };
  return { ok: true, ids: new Set(allowedPackIds) };
}

function inventoryIsValid(inventory) {
  return !!inventory && typeof inventory === 'object' && !Array.isArray(inventory)
    && Object.entries(inventory).every(([id, count]) => ingredientIds.has(id) && validCount(count));
}

function failed(state, inventory, error) {
  return { ok: false, state, inventory, error, added: emptyInventory(), spent: 0 };
}

export function createEconomy(start = START_COINS) {
  if (!validCount(start)) throw new RangeError('初始金币须为非负整数');
  return { coins: start, earned: 0, spent: 0, rewardedIds: [] };
}

/** Each block earns once per round. A new recipe clear adds one combo bonus. */
export function earnCoins(state, nodeIds, { combo = false } = {}) {
  if (!validState(state) || !Array.isArray(nodeIds)) return { state, earned: 0 };
  const rewarded = new Set(state.rewardedIds);
  const freshIds = [];
  for (const id of nodeIds) {
    if (!validNodeId(id) || rewarded.has(id)) continue;
    rewarded.add(id);
    freshIds.push(id);
  }
  const earned = freshIds.length * COINS_PER_BLOCK + (freshIds.length && combo === true ? COMBO_BONUS : 0);
  if (!earned || !validCount(state.coins + earned) || !validCount(state.earned + earned)) return { state, earned: 0 };
  return { state: { ...state, coins: state.coins + earned, earned: state.earned + earned, rewardedIds: [...state.rewardedIds, ...freshIds] }, earned };
}

function transact(state, inventory, selection, allowedPackIds) {
  if (!validState(state)) return failed(state, inventory, '金币状态无效，请重新开始本局');
  if (!inventoryIsValid(inventory)) return failed(state, inventory, '弹药数量无效，请重新开始本局');
  const access = menuAccess(allowedPackIds);
  if (!access.ok) return failed(state, inventory, '当前菜单不可用');
  if (!Array.isArray(selection) || !selection.length) return failed(state, inventory, '请先选择一份套餐');

  // buildInventory owns pack identity, modes, quantities and whole-burger
  // exclusivity. Reusing it keeps preparation and mid-round purchases equal.
  const loadout = buildInventory(selection, { budget: state.coins, maxPacks: MAX_PACKS });
  if (!loadout.ok) {
    const cost = selection.reduce((total, entry) => total + (packById.get(typeof entry === 'string' ? entry : entry?.id)?.cost ?? 0), 0);
    const error = loadout.errors.length === 1 && cost > state.coins ? `金币不足，还差 ${cost - state.coins} 金币` : loadout.error;
    return failed(state, inventory, error);
  }
  if (access.ids && loadout.selectedPackIds.some(id => !access.ids.has(id))) return failed(state, inventory, '当前菜单暂未提供这份套餐');
  if (!validCount(state.spent + loadout.spent)) return failed(state, inventory, '本局消费已达上限');
  const nextInventory = emptyInventory();
  for (const id of ingredientIds) {
    nextInventory[id] = (inventory[id] ?? 0) + loadout.inventory[id];
    if (!validCount(nextInventory[id])) return failed(state, inventory, '弹药数量已达上限');
  }
  return {
    ok: true,
    state: { ...state, coins: state.coins - loadout.spent, spent: state.spent + loadout.spent, rewardedIds: [...state.rewardedIds] },
    inventory: nextInventory,
    error: null,
    added: { ...loadout.inventory },
    spent: loadout.spent,
  };
}

/** Buy a finite quantity atomically, preserving ammunition already on the gun. */
export function purchasePack(state, inventory, { id, mode = 'split', quantity = 1, allowedPackIds } = {}) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_PACKS) return failed(state, inventory, `每次购买请选择 1 至 ${MAX_PACKS} 份套餐`);
  return transact(state, inventory, Array.from({ length: quantity }, () => ({ id, mode })), allowedPackIds);
}

/** Charge the initial selected loadout once, immediately before battle starts. */
export function payLoadout(state, selection, { allowedPackIds } = {}) {
  return transact(state, emptyInventory(), selection, allowedPackIds);
}

/** Empty ammunition is recoverable while any available pack is affordable. */
export function canRestock(state, allowedPackIds) {
  const access = menuAccess(allowedPackIds);
  return validState(state) && access.ok && PACKS.some(pack => (!access.ids || access.ids.has(pack.id)) && pack.cost <= state.coins);
}
