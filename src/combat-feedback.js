import * as THREE from 'three';

const TAU = Math.PI * 2;
const AUDIO_LIMIT = 12;
const AMMO_COLORS = { bun: '#ffcb46', patty: '#c7783d', ketchup: '#f63b35', onion: '#b86fe5', sausage: '#de7645', fry: '#ffd33c', nugget: '#ffbd39', corn: '#ffcf32', burgerbomb: '#ffb733' };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

function readVector(value, target) {
  const x = Array.isArray(value) ? value[0] : value?.x;
  const y = Array.isArray(value) ? value[1] : value?.y;
  const z = Array.isArray(value) ? value[2] : value?.z;
  if (![x, y, z].every(Number.isFinite)) return false;
  target.set(x, y, z); return true;
}

function burstGeometry() {
  const positions = [], colors = [];
  const point = (i, inset = 1) => {
    const angle = i / 20 * TAU, radius = (i % 2 ? 0.53 : 1) * inset;
    return [Math.sin(angle) * radius, Math.cos(angle) * radius, 0];
  };
  const triangle = (a, b, c, shade) => {
    positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) colors.push(shade, shade, shade);
  };
  for (let i = 0; i < 20; i++) {
    const a = point(i), b = point(i + 1), c = point(i, 0.88), d = point(i + 1, 0.88);
    triangle([0, 0, 0], c, d, 1); triangle(a, b, c, 0.05); triangle(b, d, c, 0.05);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

function pooledMaterial({ vertexColors = false } = {}) {
  const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, vertexColors });
  material.forceSinglePass = true;
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float feedbackAlpha;\nvarying float vFeedbackAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFeedbackAlpha = feedbackAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFeedbackAlpha;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vFeedbackAlpha;');
  };
  material.customProgramCacheKey = () => 'maimai-combat-alpha-v1';
  return material;
}

// Three fixed textures are painted once. No font downloads or per-hit canvases.
function captionTexture(text, fill) {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(512, 192)
    : typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!canvas) return null;
  canvas.width = 512; canvas.height = 192;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.translate(256, 101); ctx.rotate(-0.075);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.font = `italic 900 ${text === 'COMBO!' ? 105 : 126}px Arial, sans-serif`;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 23; ctx.strokeText(text, 0, 0);
  ctx.strokeStyle = '#19181a'; ctx.lineWidth = 13; ctx.strokeText(text, 0, 0);
  ctx.fillStyle = fill; ctx.fillText(text, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
  return texture;
}

/**
 * Comic accents for a toy food blaster; existing impact FX owns food debris.
 * Positions/directions accept Vector3 or [x,y,z]; update(dt) uses seconds.
 * enabled() controls sound. The caller owns AudioContext creation/resume in a
 * user gesture; this module only uses an already-running context.
 */
export function createCombatFeedback(scene, { reducedMotion = false, getAudioContext = () => null, enabled = () => true } = {}) {
  const group = new THREE.Group(); group.name = 'combat-feedback'; scene.add(group);
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  const origin = new THREE.Vector3(), direction = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const facing = new THREE.Quaternion(), pools = {};
  let disposed = false, clock = 0, fireEvents = 0, hitEvents = 0, soundEvents = 0;
  let audioContext = null, audioBus = null, noise = null;
  const voices = new Set();

  function makePool(name, capacity, geometry, billboard = false) {
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('feedbackAlpha', alpha);
    const mesh = new THREE.InstancedMesh(geometry, pooledMaterial({ vertexColors: name === 'bursts' }), capacity);
    mesh.name = `combat-feedback-${name}`; mesh.frustumCulled = false; mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, tint); mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.renderOrder = name === 'droplets' ? 5 : name === 'rings' ? 4 : 3;
    const pool = { name, capacity, mesh, alpha, billboard, cursor: 0,
      records: Array.from({ length: capacity }, () => ({ active: false, position: new THREE.Vector3(), velocity: new THREE.Vector3(), rotation: new THREE.Quaternion(), color: new THREE.Color(), age: 0, life: 1, size: 1, length: 1, angle: 0, alpha: 1, gravity: 0 })) };
    // Instanced planes face the actual render camera, including portrait framing.
    if (billboard) mesh.onBeforeRender = (_renderer, _scene, camera) => {
      camera.getWorldQuaternion(facing); flushPool(pool, facing);
    };
    group.add(mesh); pools[name] = pool;
  }
  makePool('bursts', reducedMotion ? 4 : 12, burstGeometry(), true);
  makePool('trails', reducedMotion ? 2 : 8, new THREE.CylinderGeometry(1, 1, 1, 6));
  makePool('rings', reducedMotion ? 4 : 12, new THREE.RingGeometry(0.86, 1, 36), true);
  makePool('droplets', reducedMotion ? 16 : 64, new THREE.IcosahedronGeometry(1, 1));
  const textures = { match: captionTexture('POW!', '#ffdc34'), combo: captionTexture('COMBO!', '#ffdc34'), bomb: captionTexture('BOOM!', '#ff674b') };
  const labels = Array.from({ length: 2 }, () => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: textures.match, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    sprite.name = 'combat-feedback-caption'; sprite.visible = false; sprite.renderOrder = 6; group.add(sprite);
    return { sprite, active: false, age: 0, life: 0.65, baseY: 0, size: 1 };
  });
  let labelCursor = 0;

  function add(name, position, { color = '#ffdb50', life = 0.24, size = 1, length = 1, alpha = 1, angle = 0, gravity = 0 } = {}) {
    const pool = pools[name], p = pool.records[pool.cursor++ % pool.capacity];
    p.active = true; p.position.copy(position); p.velocity.set(0, 0, 0); p.rotation.identity(); p.color.set(color);
    p.age = 0; p.life = life; p.size = size; p.length = length; p.alpha = alpha; p.angle = angle; p.gravity = gravity;
    return p;
  }
  function flushPool(pool, cameraFacing) {
    let count = 0;
    for (const p of pool.records) {
      if (!p.active) continue;
      const progress = clamp(p.age / p.life, 0, 1), remaining = 1 - progress;
      dummy.position.copy(p.position); dummy.quaternion.copy(cameraFacing || p.rotation);
      if (pool.billboard) dummy.rotateZ(p.angle);
      if (pool.name === 'bursts') dummy.scale.setScalar(p.size * (reducedMotion ? 0.85 : 0.65 + 0.55 * Math.sin(progress * Math.PI * 0.75)));
      else if (pool.name === 'rings') dummy.scale.setScalar(p.size * (0.35 + progress * (reducedMotion ? 0.45 : 1.15)));
      else if (pool.name === 'trails') dummy.scale.set(p.size * remaining, p.length, p.size * remaining);
      else dummy.scale.set(p.size, p.size * (1.15 + remaining * 0.5), p.size);
      dummy.updateMatrix(); pool.mesh.setMatrixAt(count, dummy.matrix); pool.mesh.setColorAt(count, p.color);
      pool.alpha.setX(count, p.alpha * remaining * (pool.name === 'droplets' ? Math.min(1, remaining * 3) : 1)); count++;
    }
    pool.mesh.count = count; pool.mesh.instanceMatrix.needsUpdate = true; pool.mesh.instanceColor.needsUpdate = true; pool.alpha.needsUpdate = true;
  }
  function flush() { for (const pool of Object.values(pools)) flushPool(pool); }

  function stopVoice(voice) {
    if (!voices.delete(voice)) return;
    try { voice.source.stop(); } catch { /* An already-ended source needs only disconnection. */ }
    voice.source.disconnect(); voice.gain.disconnect(); voice.filter?.disconnect(); voice.source.onended = null;
  }
  function silence() { for (const voice of [...voices]) stopVoice(voice); }
  function currentAudio() {
    if (!enabled()) { silence(); return null; }
    const context = getAudioContext();
    if (!context || context.state !== 'running') return null;
    if (context !== audioContext) {
      silence(); audioBus?.disconnect(); audioContext = context; audioBus = context.createGain();
      audioBus.gain.value = 0.7; audioBus.connect(context.destination);
      noise = context.createBuffer(1, Math.ceil(context.sampleRate * 0.24), context.sampleRate);
      const samples = noise.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / samples.length);
    }
    return context;
  }
  function tone(context, { frequency = 180, end = 65, duration = 0.12, delay = 0, volume = 0.1, type = 'sine', puff = false }) {
    while (voices.size >= AUDIO_LIMIT) stopVoice(voices.values().next().value);
    const start = context.currentTime + delay, source = puff ? context.createBufferSource() : context.createOscillator();
    const gain = context.createGain(); let filter;
    if (puff) {
      source.buffer = noise; filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = frequency;
      source.connect(filter); filter.connect(gain);
    } else {
      source.type = type; source.frequency.setValueAtTime(frequency, start); source.frequency.exponentialRampToValueAtTime(Math.max(20, end), start + duration); source.connect(gain);
    }
    gain.gain.setValueAtTime(0.0001, start); gain.gain.linearRampToValueAtTime(volume, start + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration); gain.connect(audioBus);
    const voice = { source, gain, filter }; voices.add(voice); source.onended = () => stopVoice(voice);
    source.start(start); source.stop(start + duration + 0.015);
  }
  function play(kind, streak = 1, heavy = false) {
    try {
      const context = currentAudio(); if (!context) return;
      const pitch = 2 ** (clamp(finite(streak, 1) - 1, 0, 7) / 12);
      if (kind === 'corn-fire') {
        // A quiet, rounded kernel pop ends before the next 10 Hz shot.
        tone(context, { frequency: 320, end: 180, duration: 0.045, volume: 0.035, type: 'triangle' });
      } else if (kind === 'chip') {
        tone(context, { frequency: 660, end: 620, duration: 0.065, volume: 0.043 });
        tone(context, { frequency: 175, end: 105, duration: 0.045, volume: 0.035 });
      } else if (kind === 'fire') {
        tone(context, { frequency: heavy ? 165 : 290, end: heavy ? 65 : 115, duration: 0.12, volume: 0.11 });
        tone(context, { puff: true, frequency: 750, duration: 0.07, volume: 0.07 });
      } else if (kind === 'miss') tone(context, { frequency: 165, end: 100, duration: 0.09, volume: 0.07, type: 'triangle' });
      else {
        tone(context, { frequency: kind === 'bomb' ? 105 : 170, end: kind === 'bomb' ? 38 : 65, duration: kind === 'bomb' ? 0.23 : 0.14, volume: kind === 'bomb' ? 0.23 : 0.16 });
        tone(context, { puff: true, frequency: kind === 'bomb' ? 520 : 1150, duration: 0.13, volume: 0.09 });
        const notes = kind === 'combo' ? [523.25, 659.25, 783.99, 1046.5] : kind === 'bomb' ? [261.63, 392] : [440, 659.25];
        notes.forEach((note, i) => tone(context, { frequency: note * pitch, end: note * pitch * 0.985, duration: 0.13, delay: i * 0.045, volume: kind === 'combo' ? 0.065 : 0.05, type: 'triangle' }));
      }
      soundEvents++;
    } catch { /* Audio availability never interrupts a shot or its visual cue. */ }
  }

  function fire({ position, direction: heading, ammo } = {}) {
    if (disposed || !readVector(position, origin) || !readVector(heading, direction) || direction.lengthSq() < 1e-8) return false;
    direction.normalize(); const ammoId = typeof ammo === 'string' ? ammo : ammo?.id;
    const color = typeof ammo === 'object' && ammo?.color != null ? ammo.color : AMMO_COLORS[ammoId] || '#ffce36', heavy = ammoId === 'burgerbomb', corn = ammoId === 'corn';
    origin.addScaledVector(direction, 0.18);
    if (!reducedMotion) {
      add('bursts', origin, { color: '#fff09b', size: corn ? 0.11 : heavy ? 0.34 : 0.25, life: corn ? 0.055 : 0.11, alpha: corn ? 0.64 : 1, angle: Math.random() * 0.6 });
      const p = add('trails', origin, { color, size: corn ? 0.013 : heavy ? 0.045 : 0.026, length: corn ? 0.6 : heavy ? 1.1 : 1.7, life: corn ? 0.055 : 0.1 });
      p.rotation.setFromUnitVectors(up, direction); p.position.addScaledVector(direction, p.length / 2); p.velocity.copy(direction).multiplyScalar(9);
    } else add('rings', origin, { color, size: corn ? 0.12 : 0.22, life: corn ? 0.18 : 0.25, alpha: corn ? 0.35 : 0.48 });
    fireEvents++; play(corn ? 'corn-fire' : 'fire', 1, heavy); flush(); return true;
  }
  function hit({ position, kind = 'match', color = '#f04432', count = 1, streak = 1 } = {}) {
    if (disposed || !readVector(position, origin) || !['match', 'combo', 'bomb', 'chip', 'miss'].includes(kind)) return false;
    const chip = kind === 'chip', success = kind !== 'miss' && !chip;
    const strength = (kind === 'bomb' ? 1.9 : kind === 'combo' ? 1.45 : 1) * (1 + clamp(finite(count, 1) - 1, 0, 10) * 0.025);
    // Short comic marks accompany the longer food debris in impact-fx.
    add('rings', origin, { color: chip ? '#fff3aa' : success ? '#ffdf36' : '#ffffff', size: chip ? 0.3 : strength * (success ? 1.0 : 0.42), life: chip ? (reducedMotion ? 0.26 : 0.16) : reducedMotion ? 0.4 : 0.32, alpha: chip ? (reducedMotion ? 0.4 : 0.65) : reducedMotion ? 0.5 : 0.9 });
    if (success && !reducedMotion) add('bursts', origin, { color: kind === 'bomb' ? '#ffb645' : '#ffe446', size: strength * 0.9, life: 0.18, angle: Math.random() * 0.4 });
    const drops = chip ? (reducedMotion ? 3 : 4) : reducedMotion ? (success ? 4 : 2) : (kind === 'bomb' ? 20 : kind === 'combo' ? 16 : success ? 10 : 4);
    for (let i = 0; i < drops; i++) {
      const angle = i * 2.399963, speed = chip ? (reducedMotion ? 0.8 : 1.8) : (reducedMotion ? 1.2 : 3.7) * strength;
      const p = add('droplets', origin, { color: chip ? (i % 2 ? color : '#fff8d2') : i % 4 ? color : '#ffdf36', size: chip ? 0.035 + Math.random() * 0.02 : (0.055 + Math.random() * 0.045) * strength, life: chip ? 0.15 + Math.random() * 0.06 : reducedMotion ? 0.3 : 0.38 + Math.random() * 0.22, gravity: chip ? 3 : 5 });
      p.velocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed + (chip ? 0.45 : 1.2), (Math.random() - 0.5) * speed * (chip ? 0.4 : 0.8));
    }
    if (success && textures[kind]) {
      const label = labels[labelCursor++ % labels.length];
      label.active = true; label.age = 0; label.life = kind === 'combo' ? 0.8 : 0.6; label.size = strength * 1.8;
      label.sprite.material.map = textures[kind]; label.sprite.material.opacity = 1;
      label.sprite.position.copy(origin); label.sprite.position.y += strength * 0.6; label.baseY = label.sprite.position.y;
      label.sprite.scale.set(label.size, label.size * 0.375, 1); label.sprite.visible = true;
    }
    hitEvents++; play(kind, streak); flush(); return true;
  }
  function update(dt) {
    if (disposed) return;
    const step = clamp(finite(dt, 0), 0, 0.25); clock += step;
    if (!enabled()) silence();
    for (const pool of Object.values(pools)) for (const p of pool.records) {
      if (!p.active) continue;
      p.age += step; if (p.age >= p.life) { p.active = false; continue; }
      p.position.addScaledVector(p.velocity, step); p.velocity.y -= p.gravity * step;
    }
    for (const label of labels) {
      if (!label.active) continue;
      label.age += step;
      if (label.age >= label.life) { label.active = false; label.sprite.visible = false; continue; }
      const progress = label.age / label.life, scale = reducedMotion ? 1 : 0.9 + Math.min(progress * 5, 1) * 0.15;
      label.sprite.scale.set(label.size * scale, label.size * 0.375 * scale, 1);
      label.sprite.position.y = label.baseY + (reducedMotion ? 0 : progress * 0.55);
      label.sprite.material.opacity = Math.min(1, (1 - progress) * 3);
    }
    flush();
  }
  function reset() {
    silence();
    for (const pool of Object.values(pools)) { pool.cursor = 0; for (const p of pool.records) p.active = false; }
    for (const label of labels) { label.active = false; label.sprite.visible = false; }
    labelCursor = 0; clock = 0; flush();
  }
  function dispose() {
    if (disposed) return;
    reset(); disposed = true;
    for (const pool of Object.values(pools)) { pool.mesh.geometry.dispose(); pool.mesh.material.dispose(); }
    for (const label of labels) label.sprite.material.dispose();
    for (const texture of Object.values(textures)) texture?.dispose();
    audioBus?.disconnect(); audioBus = null; audioContext = null; noise = null; scene.remove(group);
  }
  return { fire, hit, update, reset, dispose,
    get stats() {
      const counts = Object.fromEntries(Object.values(pools).map(pool => [pool.name, pool.records.filter(p => p.active).length]));
      const captions = labels.filter(label => label.active).length;
      return { ...counts, captions, active: Object.values(counts).reduce((sum, value) => sum + value, captions), capacity: Object.values(pools).reduce((sum, pool) => sum + pool.capacity, labels.length), drawCalls: Object.values(counts).filter(Boolean).length + captions, maxDrawCalls: 6, audioVoices: voices.size, maxAudioVoices: AUDIO_LIMIT, fireEvents, hitEvents, soundEvents, elapsed: clock, reducedMotion, disposed };
    },
  };
}
