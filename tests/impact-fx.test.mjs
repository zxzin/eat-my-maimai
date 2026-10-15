import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createImpactFX } from '../src/impact-fx.js';

const event = { position: [0, 1.5, 0], strength: 1.5, kind: 'heavy' };

test('food effects share bounded GPU pools and expire including landed sauce', () => {
  const scene = new THREE.Scene();
  const fx = createImpactFX(scene);
  const group = scene.children[0];
  const geometries = group.children.map(mesh => mesh.geometry);
  const materials = group.children.map(mesh => mesh.material);
  for (let i = 0; i < 250; i++) fx.ability(event);
  assert.ok(fx.stats.active > 0);
  assert.ok(fx.stats.active <= fx.stats.capacity);
  assert.equal(fx.stats.drawCalls, 5);
  for (let i = 0; i < 35; i++) fx.update(0.1);
  assert.ok(fx.stats.splats > 0, 'airborne droplets should leave sauce on the platter');
  for (let i = 0; i < 150; i++) fx.update(0.1);
  assert.equal(fx.stats.active, 0);
  assert.equal(fx.stats.drawCalls, 0);
  assert.deepEqual(group.children.map(mesh => mesh.geometry), geometries);
  assert.deepEqual(group.children.map(mesh => mesh.material), materials);
  fx.dispose();
  assert.equal(scene.children.length, 0);
  assert.equal(fx.stats.disposed, true);
});

test('reduced motion preserves a contact cue with fewer particles and no streaks', () => {
  const normal = createImpactFX(new THREE.Scene());
  const reduced = createImpactFX(new THREE.Scene(), { reducedMotion: true });
  normal.impact(event); reduced.impact(event);
  assert.ok(reduced.stats.active < normal.stats.active);
  assert.equal(reduced.stats.streaks, 0);
  assert.equal(reduced.stats.flashes, 1);
  assert.equal(reduced.stats.rings, 1);
  normal.dispose(); reduced.dispose();
});

test('reset clears all render instances and malformed events stay inert', () => {
  const scene = new THREE.Scene();
  const fx = createImpactFX(scene);
  fx.impact({ position: [NaN, 0, 0] });
  fx.ability({ position: undefined });
  assert.equal(fx.stats.active, 0);
  fx.ability({ position: [0, 0.2, 0], ammoId: 'cola' });
  assert.ok(fx.stats.splats > 0);
  const splats = scene.children[0].children.find(mesh => mesh.name === 'impact-fx-splats');
  const color = new THREE.Color();
  splats.getColorAt(0, color);
  assert.equal(color.getHexString(), '572714');
  fx.update(NaN);
  fx.reset();
  assert.equal(fx.stats.active, 0);
  assert.ok(scene.children[0].children.every(mesh => mesh.count === 0));
  fx.impact(event);
  assert.ok(fx.stats.active > 0, 'a new round can immediately show its first impact');
  fx.dispose();
});
