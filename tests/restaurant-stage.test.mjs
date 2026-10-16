import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildRestaurantStage } from '../src/restaurant-stage.js';
import { buildInventory, DEFAULT_PACK_IDS, consumeShot } from '../src/ingredient-rules.js';
import { resolveStageHit, isStageComplete } from '../src/stage-rules.js';

function createStage(seed = 1) {
  const castle = new THREE.Group(), nodes = [];
  function box(w, h, d, color, x, y, z) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }));
    mesh.position.set(x, y, z); return mesh;
  }
  const stage = buildRestaurantStage({ castle, seed, box, sign: (text, w, h, x, y, z) => box(w, h, .18, '#ce211b', x, y, z),
    addNode(ingredient, x, y, z, size, rotation, options) {
      const proxy = box(...(options.hitScale || [size * .86, size * .88, size * .8]), '#fff', x, y, z);
      proxy.rotation.z = rotation; castle.add(proxy);
      const node = { id: `food-${nodes.length}`, ingredient, x, y, z, size, rotation, hp: 1, removed: false, proxy, ...options };
      proxy.userData.nodeId = node.id; nodes.push(node); return node;
    },
  });
  castle.updateMatrixWorld(true);
  return { ...stage, castle, nodes, setpieces: stage.setpieces.map(piece => ({ ...piece, cleared: false })) };
}

function positions(stage) {
  return stage.nodes.map(({ id, ingredient, x, y, z, setpiece }) => ({ id, ingredient, x, y, z, setpiece }));
}

function firstHit(stage, target, origin, includeStructure = false) {
  const from = new THREE.Vector3(...origin), to = new THREE.Vector3(target.x, target.y, target.z);
  const ray = new THREE.Raycaster(from, to.sub(from).normalize());
  const objects = stage.nodes.filter(node => !node.removed).map(node => node.proxy);
  if (includeStructure) objects.push(...stage.structureParts.map(part => part.mesh));
  const hit = ray.intersectObjects(objects)[0];
  return hit?.object.userData.nodeId || hit?.object.userData.structureId;
}

function applyClear(stage, outcome) {
  for (const id of outcome.removeIds) stage.nodes.find(node => node.id === id).removed = true;
  for (const id of outcome.setpieceIds) stage.setpieces.find(piece => piece.id === id).cleared = true;
}

test('restaurant has forty-eight playable foods, three seven-piece mechanisms, and no food backplates', () => {
  const stage = createStage();
  assert.equal(stage.nodes.length, 48);
  assert.equal(Math.ceil(stage.nodes.length * .66), 32);
  assert.deepEqual(stage.setpieces.map(piece => piece.id), ['bucket', 'fries', 'sauce']);
  const grouped = new Set();
  for (const piece of stage.setpieces) {
    assert.equal(piece.memberIds.length, 7);
    assert.equal(piece.triggerIds.length, 1);
    assert.ok(piece.memberIds.includes(piece.triggerIds[0]));
    assert.ok(piece.ring?.isMesh);
    assert.ok(piece.decor.length > 0);
    assert.ok(piece.decor.every(mesh => mesh.userData.setpiece === piece.id));
    for (const id of piece.memberIds) {
      assert.equal(grouped.has(id), false, 'each mechanism owns a separate food group'); grouped.add(id);
      assert.equal(stage.nodes.find(node => node.id === id).setpiece, piece.id);
    }
  }
  assert.equal(grouped.size, 21);
  assert.ok(stage.nodes.every(node => node.supportless));
});

test('seeds reproduce the restaurant and vary only bounded ordinary food positions', () => {
  const first = createStage(73), duplicate = createStage(73), different = createStage(19);
  assert.deepEqual(positions(first), positions(duplicate));
  assert.notDeepEqual(positions(first), positions(different));
  for (let i = 0; i < first.nodes.length; i++) {
    const a = first.nodes[i], b = different.nodes[i];
    if (a.setpiece) assert.deepEqual([a.x, a.y, a.z], [b.x, b.y, b.z], 'trigger regions stay fixed across rounds');
    else {
      assert.ok(Math.abs(a.x - b.x) <= .16);
      assert.ok(Math.abs(a.y - b.y) <= .07);
      assert.ok(Math.abs(a.z - b.z) <= .1);
    }
  }
});

test('destructible metadata tags actual architecture in five zones and preserves the foundation', () => {
  const stage = createStage(), ids = new Set(), meshes = new Set();
  assert.equal(stage.structureParts.length, 43);
  assert.deepEqual([...new Set(stage.structureParts.map(part => part.zone))].sort(), ['facade', 'left-wing', 'loft', 'marquee', 'right-wing']);
  for (const part of stage.structureParts) {
    assert.equal(ids.has(part.id), false); ids.add(part.id);
    assert.equal(meshes.has(part.mesh), false); meshes.add(part.mesh);
    assert.equal(part.mesh.isMesh, true);
    assert.equal(part.mesh.parent, stage.castle);
    assert.equal(part.mesh.userData.structureId, part.id);
    assert.equal(part.mesh.userData.setpiece, undefined);
    assert.equal(part.mesh.userData.nodeId, undefined);
    assert.ok(part.label.length > 1);
    assert.ok(Number.isInteger(part.maxHp) && part.maxHp >= 8 && part.maxHp <= 12);
  }
  assert.equal(stage.castle.children[0].userData.structureId, undefined, 'ground foundation remains stable');
  assert.equal(stage.castle.children[1].userData.structureId, undefined, 'inner floor remains stable');
  assert.ok(stage.decor.filter(mesh => mesh.isGroup).every(mesh => !mesh.userData.structureId), 'decorative food models remain outside structural damage');
  assert.ok(stage.setpieces.every(piece => piece.decor.every(mesh => !mesh.userData.structureId)), 'mechanisms retain their existing independent reaction');
  assert.ok(stage.nodes.every(node => !node.proxy.userData.structureId), 'food keeps its matching collision path');
  assert.ok(stage.structureParts.some(part => part.mesh.isInstancedMesh), 'architectural batches retain instanced rendering');
});

test('exposed wall, roof and marquee surfaces are directly hittable from the playing cameras', () => {
  const stage = createStage();
  for (const [label, target] of [['右门柱', { x: 2.58, y: 3.3, z: .93 }], ['左斜屋顶'], ['楼顶招牌']]) {
    const part = stage.structureParts.find(item => item.label === label), at = target || part.mesh.position;
    for (const origin of [[1.25, 5.5, 15.6], [1.85, 4.5, 14.2], [.35, 5.1, 29]]) {
      assert.equal(firstHit(stage, { x: at.x, y: at.y, z: at.z }, origin, true), part.id, `${label} takes direct hits`);
    }
  }
});

test('all three triggers remain first in both viewing and off-center muzzle rays', () => {
  for (const seed of [1, 19, 73, 0xffffffff]) {
    const stage = createStage(seed);
    for (const piece of stage.setpieces) {
      const target = stage.nodes.find(node => node.id === piece.triggerIds[0]);
      for (const origin of [[1.25, 5.5, 15.6], [1.85, 4.5, 14.2], [.35, 5.1, 29]]) {
        assert.equal(firstHit(stage, target, origin), target.id, `${piece.id} stays exposed for seed ${seed}`);
        assert.equal(firstHit(stage, target, origin, true), target.id, `${piece.id} stays ahead of destructible walls for seed ${seed}`);
      }
      const outcome = resolveStageHit({ ammo: target.ingredient, target, neighbors: stage.nodes, setpieces: stage.setpieces });
      assert.ok(outcome.setpieceIds.includes(piece.id));
      assert.ok(piece.memberIds.every(id => outcome.removeIds.includes(id)));
    }
  }
});

test('default food loadout can clear thirty-two foods and all mechanisms across seeds', () => {
  for (const seed of [0, 1, 19, 73, 900, 20261016, 0xffffffff]) {
    const stage = createStage(seed);
    let inventory = buildInventory(DEFAULT_PACK_IDS).inventory, shots = 0;
    // Start with the three explicit weak spots using their indicated food.
    for (const piece of stage.setpieces) {
      const target = stage.nodes.find(node => node.id === piece.triggerIds[0]);
      const consumed = consumeShot(inventory, target.ingredient); assert.equal(consumed.ok, true); inventory = consumed.inventory; shots++;
      applyClear(stage, resolveStageHit({ ammo: target.ingredient, target, neighbors: stage.nodes, setpieces: stage.setpieces }));
    }
    while (!isStageComplete(stage.nodes.filter(node => node.removed).length, 32, stage.setpieces) && shots < 20) {
      const choices = [];
      for (const [ammo, quantity] of Object.entries(inventory)) {
        if (!quantity) continue;
        for (const target of stage.nodes.filter(node => !node.removed)) {
          if (firstHit(stage, target, [1.25, 5.5, 15.6], true) !== target.id || firstHit(stage, target, [1.85, 4.5, 14.2], true) !== target.id) continue;
          const outcome = resolveStageHit({ ammo, target, neighbors: stage.nodes, setpieces: stage.setpieces });
          if (outcome.removeIds.length) choices.push({ ammo, outcome });
        }
      }
      choices.sort((a, b) => b.outcome.removeIds.length - a.outcome.removeIds.length);
      assert.ok(choices.length, `seed ${seed} has a visible legal follow-up with its remaining ammunition`);
      const choice = choices[0]; inventory = consumeShot(inventory, choice.ammo).inventory; shots++; applyClear(stage, choice.outcome);
    }
    assert.equal(isStageComplete(stage.nodes.filter(node => node.removed).length, 32, stage.setpieces), true, `default configuration wins seed ${seed}`);
    assert.ok(shots <= 8, `seed ${seed} has a short, understandable winning route`);
  }
});

test('clearing food alone leaves the stage active until every mechanism is triggered', () => {
  const stage = createStage();
  assert.equal(isStageComplete(32, 32, stage.setpieces), false);
  stage.setpieces[0].cleared = true; stage.setpieces[1].cleared = true;
  assert.equal(isStageComplete(48, 32, stage.setpieces), false);
  stage.setpieces[2].cleared = true;
  assert.equal(isStageComplete(31, 32, stage.setpieces), false);
  assert.equal(isStageComplete(32, 32, stage.setpieces), true);
});
