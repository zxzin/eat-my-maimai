import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCombatFeedback } from '../src/combat-feedback.js';

const shot = { position: [0, 1, 2], direction: [0, 0, -1], ammo: 'ketchup' };
const impact = { position: new THREE.Vector3(0, 1, -1), kind: 'combo', color: '#e92d29', count: 8, streak: 3 };

function audioStub(state = 'running') {
  const nodes = [], frequencies = [], scheduled = [], attacks = [];
  const param = () => ({ value: 0, setValueAtTime(value, time) { frequencies.push({ value, time }); }, linearRampToValueAtTime(value, time) { attacks.push({ value, time }); }, exponentialRampToValueAtTime() {} });
  const node = () => {
    const result = { gain: param(), frequency: param(), connected: false, stopped: false, disconnected: false,
      connect() { this.connected = true; }, disconnect() { this.disconnected = true; },
      start(time) { scheduled.push(time); }, stop(time) { this.stopped = true; this.stopAt = Number.isFinite(time) ? time : 0; }, onended: null };
    nodes.push(result); return result;
  };
  return { state, currentTime: 2, sampleRate: 48000, destination: {}, nodes, frequencies, scheduled, attacks,
    advance(seconds) { this.currentTime += seconds; for (const node of nodes) if (node.onended && node.stopAt <= this.currentTime) node.onended(); },
    createGain: node, createOscillator: node, createBufferSource: node, createBiquadFilter: node,
    createBuffer(_channels, length) { return { getChannelData: () => new Float32Array(length) }; } };
}

test('combat feedback reuses fixed GPU pools under sustained fire and fully expires', () => {
  const scene = new THREE.Scene(), fx = createCombatFeedback(scene);
  const meshes = scene.children[0].children.filter(child => child.isInstancedMesh);
  const resources = meshes.map(mesh => [mesh.geometry, mesh.material, mesh.instanceMatrix]);
  for (let i = 0; i < 400; i++) { fx.fire(shot); fx.hit(impact); }
  assert.ok(fx.stats.active > 0 && fx.stats.active <= fx.stats.capacity);
  assert.ok(fx.stats.drawCalls <= 6);
  assert.equal(fx.stats.fireEvents, 400); assert.equal(fx.stats.hitEvents, 400);
  assert.ok(meshes.every(mesh => mesh.material.forceSinglePass), 'transparent double-sided accents use one pass');
  assert.deepEqual(meshes.map(mesh => [mesh.geometry, mesh.material, mesh.instanceMatrix]), resources);
  for (let i = 0; i < 10; i++) fx.update(0.1);
  assert.equal(fx.stats.active, 0); assert.equal(fx.stats.drawCalls, 0);
  fx.dispose(); assert.equal(scene.children.length, 0);
});

test('reset clears particles and replay works; dispose releases resources and ignores new events', () => {
  const scene = new THREE.Scene(), fx = createCombatFeedback(scene);
  let geometryDisposals = 0, materialDisposals = 0;
  scene.children[0].children.forEach(mesh => {
    if (mesh.isInstancedMesh) mesh.geometry.addEventListener('dispose', () => geometryDisposals++);
    mesh.material.addEventListener('dispose', () => materialDisposals++);
  });
  fx.fire(shot); fx.hit(impact); fx.reset();
  assert.equal(fx.stats.active, 0);
  assert.ok(scene.children[0].children.every(mesh => mesh.isSprite ? !mesh.visible : mesh.count === 0));
  fx.hit(impact); assert.ok(fx.stats.active > 0);
  fx.dispose(); fx.dispose();
  assert.equal(geometryDisposals, 4); assert.equal(materialDisposals, 6);
  assert.equal(fx.hit(impact), false); assert.equal(fx.fire(shot), false);
  assert.equal(fx.stats.active, 0); assert.equal(fx.stats.disposed, true);
});

test('invalid positions stay inert and reduced motion retains soft cues without flashes or trails', () => {
  const normal = createCombatFeedback(new THREE.Scene());
  const reduced = createCombatFeedback(new THREE.Scene(), { reducedMotion: true });
  assert.equal(normal.fire({ ...shot, direction: [0, 0, 0] }), false);
  assert.equal(normal.hit({ ...impact, position: [NaN, 1, 0] }), false);
  assert.equal(normal.hit({ ...impact, kind: 'unknown' }), false);
  assert.equal(normal.stats.active, 0);
  for (const fx of [normal, reduced]) { fx.fire(shot); fx.hit(impact); fx.update(NaN); }
  assert.ok(reduced.stats.active > 0 && reduced.stats.active < normal.stats.active);
  assert.equal(reduced.stats.bursts, 0); assert.equal(reduced.stats.trails, 0);
  normal.reset(); normal.hit({ ...impact, kind: 'miss' });
  assert.equal(normal.stats.bursts, 0); assert.equal(normal.stats.captions, 0);
  normal.dispose(); reduced.dispose();
});

test('mute and suspended contexts produce no audio while retaining visible feedback', () => {
  const context = audioStub('suspended'); let soundEnabled = false, requested = 0;
  const fx = createCombatFeedback(new THREE.Scene(), { enabled: () => soundEnabled, getAudioContext: () => { requested++; return context; } });
  fx.fire(shot); assert.ok(fx.stats.active > 0); assert.equal(requested, 0);
  soundEnabled = true; fx.hit(impact);
  assert.equal(context.nodes.length, 0); assert.equal(fx.stats.soundEvents, 0);
  context.state = 'running'; fx.hit(impact);
  assert.equal(fx.stats.soundEvents, 1); assert.ok(fx.stats.audioVoices > 0);
  soundEnabled = false; fx.update(0.016);
  assert.equal(fx.stats.audioVoices, 0);
  assert.ok(context.nodes.filter(node => node.onended !== null).length === 0);
  fx.dispose();
});

test('layered audio has a hard voice limit, ascending combo notes, and stops on reset', () => {
  const context = audioStub();
  const fx = createCombatFeedback(new THREE.Scene(), { getAudioContext: () => context });
  fx.hit({ ...impact, streak: 1 });
  const pitches = context.frequencies.filter(({ value }) => value > 500).map(({ value }) => value);
  assert.deepEqual(pitches, [523.25, 659.25, 783.99, 1046.5]);
  assert.ok(context.scheduled.some(time => time > context.currentTime), 'combo tones are spread across time');
  for (let i = 0; i < 50; i++) { fx.fire(shot); fx.hit(impact); }
  assert.ok(fx.stats.audioVoices > 0 && fx.stats.audioVoices <= fx.stats.maxAudioVoices);
  fx.reset(); assert.equal(fx.stats.audioVoices, 0); assert.equal(fx.stats.active, 0);
  fx.dispose(); assert.ok(context.nodes.every(node => node.disconnected));
});

test('corn chip contact has a small yellow-white cue and a clear ding distinct from a miss', () => {
  const scene = new THREE.Scene(), context = audioStub();
  const fx = createCombatFeedback(scene, { getAudioContext: () => context });
  const color = new THREE.Color(), matrix = new THREE.Matrix4(), scale = new THREE.Vector3();
  const rings = scene.children[0].getObjectByName('combat-feedback-rings');
  const droplets = scene.children[0].getObjectByName('combat-feedback-droplets');
  assert.equal(fx.hit({ ...impact, kind: 'chip', color: '#ffcf32', count: 100 }), true);
  assert.equal(fx.stats.bursts, 0); assert.equal(fx.stats.captions, 0);
  assert.equal(fx.stats.rings, 1); assert.equal(fx.stats.droplets, 4);
  rings.getColorAt(0, color); assert.equal(color.getHexString(), 'fff3aa');
  rings.getMatrixAt(0, matrix); scale.setFromMatrixScale(matrix);
  assert.ok(scale.x < 0.12, 'chip count never enlarges a small contact ring');
  const palette = new Set();
  for (let i = 0; i < droplets.count; i++) { droplets.getColorAt(i, color); palette.add(color.getHexString()); }
  assert.deepEqual(palette, new Set(['fff8d2', 'ffcf32']));
  assert.deepEqual(context.frequencies.filter(({ value }) => value >= 20).map(({ value }) => value), [660, 175]);
  fx.reset();
  const previous = context.frequencies.length;
  fx.hit({ ...impact, kind: 'miss', color: '#ffcf32' });
  rings.getColorAt(0, color); assert.equal(color.getHexString(), 'ffffff');
  assert.deepEqual(context.frequencies.slice(previous).filter(({ value }) => value >= 20).map(({ value }) => value), [165]);
  fx.dispose();
});

test('corn muzzle pop is smaller and quieter, and ten shots per second retain fixed limits', () => {
  const scene = new THREE.Scene(), context = audioStub();
  const fx = createCombatFeedback(scene, { getAudioContext: () => context });
  const bursts = scene.children[0].getObjectByName('combat-feedback-bursts');
  const matrix = new THREE.Matrix4(), scale = new THREE.Vector3();
  fx.fire(shot); bursts.getMatrixAt(0, matrix); scale.setFromMatrixScale(matrix);
  const regularSize = scale.x; fx.reset();
  const firstCornAttack = context.attacks.length;
  fx.fire({ ...shot, ammo: 'corn' }); bursts.getMatrixAt(0, matrix); scale.setFromMatrixScale(matrix);
  assert.ok(scale.x < regularSize / 2);
  assert.equal(fx.stats.audioVoices, 1);
  assert.ok(context.attacks.slice(firstCornAttack).every(({ value }) => value <= 0.043), 'rapid fire uses the quiet kernel voice');
  fx.reset(); context.advance(0.1);
  const capacity = fx.stats.capacity;
  for (let i = 0; i < 100; i++) {
    fx.fire({ ...shot, ammo: 'corn' }); fx.hit({ ...impact, kind: 'chip', color: '#ffcf32' });
    assert.ok(fx.stats.active <= capacity && fx.stats.audioVoices <= 3, '10 Hz corn audio ends before the next shot');
    assert.ok(fx.stats.drawCalls <= 4); assert.equal(fx.stats.captions, 0);
    fx.update(0.1); context.advance(0.1);
  }
  for (let i = 0; i < 100; i++) { fx.fire({ ...shot, ammo: 'corn' }); fx.hit({ ...impact, kind: 'chip' }); }
  assert.equal(fx.stats.capacity, capacity);
  assert.equal(fx.stats.maxAudioVoices, 12); assert.ok(fx.stats.audioVoices <= 12);
  assert.ok(fx.stats.active <= capacity);
  fx.reset(); assert.equal(fx.stats.active, 0); assert.equal(fx.stats.audioVoices, 0);
  fx.dispose();
});

test('reduced-motion corn uses three small crumbs and soft rings without flash or caption', () => {
  const fx = createCombatFeedback(new THREE.Scene(), { reducedMotion: true });
  fx.fire({ ...shot, ammo: 'corn' }); fx.hit({ ...impact, kind: 'chip', color: '#ffcf32' });
  assert.equal(fx.stats.bursts, 0); assert.equal(fx.stats.trails, 0); assert.equal(fx.stats.captions, 0);
  assert.equal(fx.stats.droplets, 3); assert.equal(fx.stats.rings, 2);
  for (let i = 0; i < 4; i++) fx.update(0.1);
  assert.equal(fx.stats.active, 0); fx.dispose();
});
