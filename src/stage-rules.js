import { resolveHit } from './ingredient-rules.js';

/** A real ingredient clear opens a setpiece; its released food can open another. */
export function resolveStageHit({ ammo, target, neighbors = [], setpieces = [] } = {}) {
  const base = resolveHit({ ammo, target, neighbors });
  const live = new Map(neighbors.filter(node => !node.removed && node.destructible !== false && (node.hp === undefined || node.hp > 0)).map(node => [node.id, node]));
  const removed = new Set(base.removeIds);
  const activated = new Set();
  let changed = true;
  while (changed && removed.size) {
    changed = false;
    for (const setpiece of setpieces) {
      if (setpiece.cleared || activated.has(setpiece.id) || !setpiece.triggerIds.some(id => removed.has(id))) continue;
      activated.add(setpiece.id);
      for (const id of [...setpiece.triggerIds, ...setpiece.memberIds]) if (live.has(id)) removed.add(id);
      changed = true;
    }
  }
  const active = setpieces.filter(setpiece => activated.has(setpiece.id));
  return { ...base, removeIds: [...removed], setpieceIds: [...activated],
    label: active.length ? `${active.map(setpiece => setpiece.label).join(' ＋ ')} · 连锁爆开` : base.label };
}

export function isStageComplete(removed, goal, setpieces) {
  return removed >= goal && setpieces.length > 0 && setpieces.every(setpiece => setpiece.cleared);
}
