import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildingAmmoDamage, createBuildingDamage } from '../src/building-damage.js';

function fixture(specs = [{ id: 'wall', zone: 'facade', maxHp: 4, x: 0, y: 2 }], options = {}) {
  const scene = new THREE.Scene(), castle = new THREE.Group(); scene.add(castle);
  const material = new THREE.MeshStandardMaterial({ color: '#cc2117' });
  const parts = specs.map(spec => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1.5, .2), material);
    mesh.position.set(spec.x ?? 0, spec.y ?? 2, spec.z ?? 0); castle.add(mesh);
    return { label: '红墙', ...spec, mesh };
  });
  const events = [];
  return { scene, castle, parts, material, events, damage: createBuildingDamage({ scene, parts, onImpact: event => events.push(event), ...options }) };
}
const point = { x: .1, y: 2.1, z: .11 }, normal = { x: 0, y: 0, z: 1 };

test('corn chips durability, visibly cracks on the first hit, and removes a destroyed collider once', () => {
  const { damage, events } = fixture();
  assert.equal(buildingAmmoDamage('corn'), 1);
  assert.equal(buildingAmmoDamage('burgerbomb'), 10);
  assert.equal(damage.targets.length, 1);
  const first = damage.hit({ partId: 'wall', ammo: 'corn', point, normal });
  assert.equal(first.damage, 1); assert.equal(first.remaining, 3); assert.equal(first.destroyed, false);
  assert.equal(damage.state.parts[0].crackLevel, 1); assert.equal(damage.state.cracks, 1);
  assert.equal(damage.targets.length, 1);
  for (let i = 0; i < 3; i++) damage.hit({ partId: 'wall', ammo: 'corn', point, normal });
  assert.equal(damage.state.parts[0].status, 'queued'); assert.equal(damage.targets.length, 0);
  assert.equal(damage.hit({ partId: 'wall', ammo: 'patty', point, normal }).hit, false);
  assert.equal(events.length, 4); assert.equal(events.filter(event => event.destroyed).length, 1);
  damage.update(1.5);
  assert.equal(damage.state.parts[0].status, 'rubble'); assert.equal(damage.state.parts[0].collapseProgress, 1);
  damage.dispose();
});

test('burger bombs damage a nearby facade and preserve distant sections', () => {
  const { damage } = fixture([
    { id: 'hit', maxHp: 10, x: 0 }, { id: 'neighbor', maxHp: 12, x: 1.5 }, { id: 'far', maxHp: 12, x: 8 },
  ]);
  const result = damage.hit({ partId: 'hit', ammo: { id: 'burgerbomb' }, point, normal });
  assert.equal(result.destroyed, true); assert.deepEqual(result.affectedIds, ['hit', 'neighbor']);
  assert.deepEqual(damage.state.parts.map(part => part.hp), [0, 4, 12]);
  damage.dispose();
});

test('mechanisms stagger lower supports before the roof and leave the other wing intact', () => {
  const { damage } = fixture([
    { id: 'roof', zone: 'left-wing', y: 5 }, { id: 'support', zone: 'left-wing', y: 1 }, { id: 'right', zone: 'right-wing', x: 5 },
  ]);
  assert.deepEqual(damage.collapseZone('left-wing'), { count: 2, duration: 1.9 });
  assert.deepEqual(damage.collapseZone('left-wing'), { count: 0, duration: 0 });
  assert.equal(damage.targets.length, 1);
  damage.update(.2);
  const snapshot = damage.state;
  assert.equal(snapshot.parts.find(part => part.id === 'support').status, 'falling');
  assert.equal(snapshot.parts.find(part => part.id === 'roof').status, 'queued');
  assert.equal(snapshot.parts.find(part => part.id === 'right').status, 'intact');
  damage.update(2);
  assert.equal(damage.state.rubble, 2); assert.equal(damage.state.intact, 1);
  damage.dispose();
});

test('final collapse completes within 2.4 seconds and preserves bounded persistent rubble', () => {
  const { damage, parts } = fixture(Array.from({ length: 60 }, (_, index) => ({ id: `wall-${index}`, x: index % 10 - 5, y: Math.floor(index / 10) + 1 })));
  const result = damage.collapseAll();
  assert.equal(result.count, 60); assert.equal(result.duration, 2.4);
  assert.equal(damage.collapseAll().count, 0); assert.equal(damage.targets.length, 0);
  damage.update(2.5);
  assert.equal(damage.state.rubble, 60); assert.equal(damage.state.falling, 0);
  assert.ok(damage.state.debris <= 48); assert.ok(parts.every(part => part.mesh.visible));
  assert.ok(parts.every(part => new THREE.Box3().setFromObject(part.mesh).min.y >= .149));
  damage.dispose();
});

test('material tint is isolated from neighboring meshes and disposal restores borrowed resources', () => {
  const { damage, parts, castle, scene, material } = fixture([{ id: 'hit', maxHp: 3 }, { id: 'other', x: 3 }]);
  const originalPosition = parts[0].mesh.position.clone();
  let borrowedDisposed = 0, ownedDisposed = 0;
  material.addEventListener('dispose', () => borrowedDisposed++);
  damage.hit({ partId: 'hit', ammo: 'patty', point, normal });
  assert.notEqual(parts[0].mesh.material, material); assert.equal(parts[1].mesh.material, material);
  parts[0].mesh.material.addEventListener('dispose', () => ownedDisposed++);
  damage.update(1.5); assert.equal(parts[0].mesh.parent, scene);
  damage.dispose(); damage.dispose();
  assert.equal(parts[0].mesh.parent, castle); assert.deepEqual(parts[0].mesh.position, originalPosition);
  assert.equal(parts[0].mesh.material, material); assert.equal(borrowedDisposed, 0); assert.equal(ownedDisposed, 1);
  assert.equal(parts[0].mesh.userData.structureId, undefined); assert.equal(damage.targets.length, 0);
  assert.equal(damage.state.cracks, 0); assert.equal(damage.state.debris, 0);
});

test('invalid numbers, ammo and duplicate hits leave durability unchanged; snapshots are detached', () => {
  const { damage } = fixture();
  for (const invalid of [
    { ammo: 'corn', point: { x: NaN, y: 0, z: 0 } },
    { ammo: 'corn', point, normal: { x: 0, y: 0, z: 0 } },
    { ammo: 'corn', point, normal: { x: Infinity, y: 0, z: 1 } },
    { ammo: 'unknown', point },
  ]) assert.equal(damage.hit({ partId: 'wall', ...invalid }).hit, false);
  const snapshot = damage.state; snapshot.parts[0].hp = 0; snapshot.parts[0].position.y = -100;
  damage.update(NaN); damage.update(-1);
  assert.equal(damage.state.parts[0].hp, 4); assert.equal(damage.state.parts[0].position.y, 2);
  assert.equal(damage.state.cracks, 0); assert.equal(buildingAmmoDamage('unknown'), 0);
  damage.dispose();
});

test('falling advances only with update and reduced motion uses a short bounded drop', () => {
  const { damage } = fixture(undefined, { reducedMotion: true });
  damage.collapseAll();
  const queued = damage.state;
  assert.deepEqual(damage.state, queued);
  damage.update(.16);
  assert.equal(damage.state.parts[0].status, 'falling'); assert.ok(damage.state.parts[0].collapseProgress > 0);
  const paused = damage.state; assert.deepEqual(damage.state, paused);
  damage.update(.2); assert.equal(damage.state.rubble, 1);
  damage.dispose();
});

test('repeated impacts cap cracks and transient chips', () => {
  const { damage } = fixture(Array.from({ length: 50 }, (_, index) => ({ id: index, maxHp: 10, x: index })));
  for (let index = 0; index < 50; index++) damage.hit({ partId: index, ammo: 'corn', point: { x: index, y: 2, z: .11 }, normal });
  assert.equal(damage.state.cracks, 36); assert.equal(damage.state.debris, 48);
  damage.update(2); assert.equal(damage.state.debris, 0);
  damage.dispose();
});

test('instanced upper trim uses visible bounds for collapse ordering and crack hits retain their structure id', () => {
  const { damage: unused, scene, castle } = fixture([]); unused.dispose();
  const geometry = new THREE.BoxGeometry(1, 1, .2), material = new THREE.MeshStandardMaterial();
  const trim = new THREE.InstancedMesh(geometry, material, 1);
  trim.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 6, 0)); castle.add(trim);
  const lower = new THREE.Mesh(geometry, material); lower.position.set(0, 1, 0); castle.add(lower);
  const damage = createBuildingDamage({ scene, parts: [
    { id: 'trim', zone: 'loft', mesh: trim, maxHp: 8 }, { id: 'lower', zone: 'loft', mesh: lower, maxHp: 8 },
  ] });
  damage.hit({ partId: 'trim', ammo: 'corn', point: { x: 0, y: 6, z: .11 }, normal });
  assert.equal(trim.children[0].children.every(mesh => mesh.userData.structureId === 'trim'), true);
  assert.ok(damage.state.parts.find(part => part.id === 'trim').position.y > 5.9);
  damage.collapseZone('loft'); damage.update(.2);
  assert.equal(damage.state.parts.find(part => part.id === 'lower').status, 'falling');
  assert.equal(damage.state.parts.find(part => part.id === 'trim').status, 'queued');
  damage.update(2); assert.ok(new THREE.Box3().setFromObject(trim).min.y >= .149);
  damage.dispose();
});

test('cracks stay inside a narrow struck face and leave structural bounds unchanged', () => {
  const scene = new THREE.Scene(), mesh = new THREE.Mesh(new THREE.BoxGeometry(.34, 3.75, 2.25), new THREE.MeshStandardMaterial());
  mesh.position.set(-3.38, 2.25, -.2); scene.add(mesh);
  const damage = createBuildingDamage({ scene, parts: [{ id: 'pillar', zone: 'facade', mesh, maxHp: 12 }] });
  const before = damage.state.parts[0].position;
  damage.hit({ partId: 'pillar', ammo: 'corn', point: { x: -3.22, y: 4.1, z: .925 }, normal });
  const fracture = mesh.children[0], bounds = new THREE.Box3().setFromObject(fracture);
  assert.ok(bounds.min.x >= -3.55 && bounds.max.x <= -3.21, 'narrow cracks fit the pillar width');
  assert.ok(bounds.min.y >= .375 && bounds.max.y <= 4.125, 'edge impacts keep cracks within the top and bottom');
  assert.deepEqual(damage.state.parts[0].position, before, 'decals never change the visible structural center');
  const [edge, dark] = fracture.children;
  assert.notEqual(edge.geometry, dark.geometry, 'outline and center use separate stroke widths');
  assert.deepEqual(edge.scale, dark.scale, 'the shared crack path stays aligned');
  assert.ok(edge.renderOrder < dark.renderOrder, 'the dark center is drawn over its light outline');
  assert.equal(edge.material.color.getHexString(), 'fff5d6');
  assert.ok(bounds.getSize(new THREE.Vector3()).y > bounds.getSize(new THREE.Vector3()).x * 2, 'narrow supports receive vertical fractures');
  damage.dispose();
});

test('deep narrow columns fall onto their thin side rather than staying upright', () => {
  const scene = new THREE.Scene(), mesh = new THREE.Mesh(new THREE.BoxGeometry(.34, 3.75, 2.25), new THREE.MeshStandardMaterial());
  mesh.position.set(2.58, 2.25, -.2); scene.add(mesh);
  const damage = createBuildingDamage({ scene, parts: [{ id: 'door-column', zone: 'facade', mesh, maxHp: 12 }] });
  damage.collapseAll(); damage.update(2.5);
  const bounds = new THREE.Box3().setFromObject(mesh), dimensions = bounds.getSize(new THREE.Vector3());
  assert.equal(damage.state.rubble, 1);
  assert.ok(dimensions.y < .8, `column rubble is flat; actual height ${dimensions.y}`);
  assert.ok(bounds.min.y >= .149); assert.ok(dimensions.x > dimensions.y * 3);
  damage.dispose();
});
