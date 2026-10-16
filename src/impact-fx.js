import * as THREE from 'three';

const TAU = Math.PI * 2;
const FLOOR = 0.038;
const COLORS = {
  ketchup: '#e92d29', mustard: '#ffc529', mayo: '#fff2cc',
  cola: '#572714', caramel: '#a65321', cream: '#fff7e5', cookie: '#543b2d',
};
const AMMO_KIND = { bigmac: 'heavy', spicy: 'boost', nuggets: 'split', fries: 'scatter', cola: 'slide', mcflurry: 'burst' };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const random = (min, max) => min + Math.random() * (max - min);

function splatGeometry() {
  const shape = new THREE.Shape();
  const points = Array.from({ length: 28 }, (_, i) => {
    const angle = i / 28 * TAU;
    const radius = 0.8 + 0.19 * Math.sin(angle * 5 + 0.6) + 0.1 * Math.cos(angle * 9);
    return new THREE.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius);
  });
  const start = points[0].clone().add(points.at(-1)).multiplyScalar(0.5);
  shape.moveTo(start.x, start.y);
  points.forEach((point, i) => {
    const next = point.clone().add(points[(i + 1) % points.length]).multiplyScalar(0.5);
    shape.quadraticCurveTo(point.x, point.y, next.x, next.y);
  });
  shape.closePath();
  return new THREE.ShapeGeometry(shape, 3);
}

// One opacity attribute per instance keeps fading particles in a fixed number
// of draw calls. Events allocate particle records, never GPU resources.
function fadingMaterial({ unlit = false, ...options } = {}) {
  const material = unlit
    ? new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, ...options })
    : new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false, roughness: 0.38, ...options });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float instanceAlpha;\nvarying float vInstanceAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceAlpha = instanceAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vInstanceAlpha;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vInstanceAlpha;');
  };
  material.customProgramCacheKey = () => 'food-impact-instance-alpha-v1';
  return material;
}

function makePool(group, name, capacity, geometry, material) {
  const opacity = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  opacity.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('instanceAlpha', opacity);
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = `impact-fx-${name}`;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color());
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = name === 'splats' ? 1 : 2;
  group.add(mesh);
  return { name, capacity, mesh, opacity, particles: [] };
}

/** Bounded, self-contained food impact effects. Call update with elapsed seconds. */
export function createImpactFX(scene, { reducedMotion = false, floorAt = (x, z) => Math.hypot(x, z) <= 7.08 ? FLOOR : -2.96 } = {}) {
  const group = new THREE.Group();
  group.name = 'food-impact-effects';
  scene.add(group);
  const limit = reducedMotion ? 0.4 : 1;
  const pools = {
    crumbs: makePool(group, 'crumbs', Math.ceil(112 * limit), new THREE.IcosahedronGeometry(1, 0), fadingMaterial({ roughness: 0.85 })),
    droplets: makePool(group, 'droplets', Math.ceil(96 * limit), new THREE.SphereGeometry(1, 8, 6), fadingMaterial({ roughness: 0.2 })),
    splats: makePool(group, 'splats', Math.ceil(80 * limit), splatGeometry(), fadingMaterial({ side: THREE.DoubleSide, roughness: 0.25, polygonOffset: true, polygonOffsetFactor: -1 })),
    flashes: makePool(group, 'flashes', Math.ceil(20 * limit), new THREE.SphereGeometry(1, 8, 6), fadingMaterial({ unlit: true, toneMapped: false })),
    rings: makePool(group, 'rings', Math.ceil(10 * limit), new THREE.TorusGeometry(1, 0.035, 5, 48), fadingMaterial({ unlit: true, toneMapped: false })),
    streaks: makePool(group, 'streaks', Math.ceil(42 * limit), new THREE.ConeGeometry(0.1, 1, 4), fadingMaterial({ unlit: true, toneMapped: false })),
  };
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const direction = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let clock = 0;
  let disposed = false;
  let lastImpact = -10;

  function add(poolName, record) {
    const pool = pools[poolName];
    if (pool.particles.length >= pool.capacity) pool.particles.shift();
    pool.particles.push({ age: 0, rx: 0, ry: 0, rz: 0, vx: 0, vy: 0, vz: 0, spin: 0, ...record });
  }

  function paletteFor(event) {
    const kind = event.kind;
    if (event.foodModel === 'ketchup' || event.ammoId === 'ketchup') return [COLORS.ketchup, '#bb151c', '#ff4827'];
    if (kind === 'slide') return [COLORS.cola, COLORS.caramel, COLORS.cola];
    if (kind === 'burst') return [COLORS.cream, COLORS.cream, COLORS.cookie];
    return [COLORS.ketchup, COLORS.mustard, COLORS.mayo];
  }

  function stamp(x, z, size, colorValue, life = 6) {
    // Each scene provides its actual receiving surface for landed sauce.
    const floor = floorAt(x, z);
    add('splats', { x, y: floor + random(0, 0.008), z, size, color: colorValue, life, rx: -Math.PI / 2, rz: random(0, TAU), squash: random(0.7, 1.3) });
  }

  function normalize(event) {
    if (!event || !Array.isArray(event.position) || event.position.length < 3 || !event.position.every(Number.isFinite)) return null;
    const kind = event.kind || AMMO_KIND[event.ammoId || event.ammo] || (event.foodModel === 'cola' ? 'slide' : event.foodModel === 'icecream' ? 'burst' : 'heavy');
    return { ...event, kind, strength: clamp(Number.isFinite(event.strength) ? event.strength : 1, 0.2, 2), position: event.position };
  }

  function burst(event, { ability = false, target = false } = {}) {
    if (disposed) return;
    const e = normalize(event);
    if (!e) return;
    const [x, y, z] = e.position;
    const heavy = e.kind === 'heavy';
    const strength = e.strength * (target ? 1.2 : ability ? 1.12 : 1);
    const motion = reducedMotion ? 0.45 : 1;
    const palette = paletteFor(e);
    const radius = clamp((heavy ? 1.45 : 1.05) * strength, 0.55, 2.5);
    const tint = e.kind === 'burst' ? '#fff6de' : e.kind === 'slide' ? '#f8c672' : '#ffe36a';

    // A short, warm white core and surrounding sauce-colored lobes create an
    // edible cartoon pop. Reduced motion retains one soft contact cue.
    add('flashes', { x, y, z, size: radius * (reducedMotion ? 0.42 : 0.64), color: '#fff7ce', life: reducedMotion ? 0.3 : 0.2, core: true });
    if (!reducedMotion) {
      for (let i = 0; i < 5; i++) {
        const a = i / 5 * TAU;
        add('flashes', { x: x + Math.sin(a) * radius * 0.24, y: y + Math.cos(a) * radius * 0.19, z: z + Math.cos(a + 0.8) * radius * 0.22, size: radius * 0.48, color: i % 2 ? tint : '#ff9d27', life: 0.25 + i * 0.013 });
      }
    }
    add('rings', { x, y: Math.max(y, FLOOR + 0.05), z, size: radius * (reducedMotion ? 0.65 : 1.75), color: tint, life: reducedMotion ? 0.35 : 0.5, rx: -Math.PI / 2 });
    if (heavy && !reducedMotion) add('rings', { x, y, z, size: radius * 1.35, color: '#fff3b0', life: 0.38, rx: 0.3, rz: 0.25 });

    const crumbColors = e.kind === 'burst' ? [COLORS.cookie, COLORS.cream, '#d5b991'] : ['#fff0bd', '#ef9c35', '#7bbb45', '#ffd02e', '#b76825'];
    const count = Math.round((target ? 30 : heavy ? 24 : 17) * strength * limit);
    for (let i = 0; i < count; i++) {
      const a = i * 2.399 + random(-0.2, 0.2);
      const speed = random(1.3, 5.0) * strength * motion;
      const sesame = i % 4 === 0;
      add('crumbs', { x, y: y + random(-0.06, 0.1), z,
        vx: Math.sin(a) * speed, vy: random(2, 5.7) * motion, vz: Math.cos(a) * speed,
        size: sesame ? random(0.055, 0.09) : random(0.1, 0.2), stretch: sesame ? 2.4 : random(0.7, 1.8),
        color: sesame ? '#fff3cc' : crumbColors[i % crumbColors.length], life: random(0.9, 1.7), spin: random(-7, 7), rx: a, rz: a * 0.7 });
    }
    const drops = Math.round((e.kind === 'slide' || e.kind === 'burst' ? 24 : heavy ? 19 : 13) * strength * limit);
    for (let i = 0; i < drops; i++) {
      const angle = i * 2.399 + random(-0.15, 0.15);
      const speed = random(1.4, 4.3) * strength * motion;
      add('droplets', { x, y: y + 0.12, z,
        vx: Math.sin(angle) * speed, vy: random(2.2, 6.2) * motion, vz: Math.cos(angle) * speed,
        color: palette[i % palette.length], size: random(0.09, 0.2) * (heavy ? 1.18 : 1), life: 3.2 });
    }
    if (!reducedMotion) {
      const rays = target ? 14 : 10;
      for (let i = 0; i < rays; i++) {
        const a = i / rays * TAU;
        add('streaks', { x, y, z, vx: Math.sin(a) * radius * 2.9, vy: Math.cos(a) * radius * 2.2, vz: Math.cos(a + 0.9) * radius * 2.2,
          color: i % 2 ? '#fff8d9' : '#ffc62c', size: random(0.45, 0.85) * radius, life: 0.24, rz: -a });
      }
    }
    if (y < 1.1 || e.kind === 'slide') {
      stamp(x, z, radius * (e.kind === 'slide' ? 1.05 : 0.5), palette[0], e.kind === 'slide' ? 8 : 6);
      for (let i = 0; i < 5; i++) {
        const a = i * 2.399;
        stamp(x + Math.sin(a) * radius * 0.6, z + Math.cos(a) * radius * 0.6, random(0.14, 0.29), palette[i % palette.length]);
      }
    }
    flush();
  }

  function flush() {
    for (const pool of Object.values(pools)) {
      pool.mesh.count = pool.particles.length;
      for (let i = 0; i < pool.particles.length; i++) {
        const p = pool.particles[i];
        const progress = clamp(p.age / p.life, 0, 1);
        const remaining = 1 - progress;
        let sx = p.size, sy = p.size, sz = p.size, alpha = 1;
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(p.rx, p.ry, p.rz);
        if (pool.name === 'crumbs') {
          sx *= p.stretch; sy *= 0.6; alpha = clamp(remaining * 4, 0, 1);
        } else if (pool.name === 'droplets') {
          sy *= 1.3 + Math.min(1.5, Math.abs(p.vy) * 0.1);
          direction.set(p.vx, p.vy, p.vz).normalize();
          if (direction.lengthSq() > 0) dummy.quaternion.setFromUnitVectors(up, direction);
          alpha = clamp(remaining * 5, 0, 1);
        } else if (pool.name === 'splats') {
          const spread = 0.65 + 0.35 * clamp(p.age * 9, 0, 1);
          sx *= spread; sy *= spread * p.squash; sz = 1;
          alpha = 0.84 * clamp(remaining * 3, 0, 1);
        } else if (pool.name === 'flashes') {
          sx *= 0.55 + progress * 1.0; sy = sx; sz = sx;
          alpha = remaining * (p.core ? 0.8 : 0.55);
        } else if (pool.name === 'rings') {
          sx *= 0.24 + progress * 0.76; sy = sx; sz = Math.max(0.15, remaining);
          alpha = 0.95 * remaining;
        } else if (pool.name === 'streaks') {
          sx *= 0.7 * remaining; sy *= 0.5 + progress; sz *= 0.7 * remaining;
          direction.set(p.vx, p.vy, p.vz).normalize();
          dummy.quaternion.setFromUnitVectors(up, direction);
          alpha = remaining;
        }
        dummy.scale.set(sx, sy, sz);
        dummy.updateMatrix();
        pool.mesh.setMatrixAt(i, dummy.matrix);
        pool.mesh.setColorAt(i, color.set(p.color));
        pool.opacity.setX(i, alpha);
      }
      if (pool.particles.length) {
        pool.mesh.instanceMatrix.needsUpdate = true;
        pool.mesh.instanceColor.needsUpdate = true;
        pool.opacity.needsUpdate = true;
      }
    }
  }

  function update(dt) {
    if (disposed || !Number.isFinite(dt) || dt <= 0) return;
    const elapsed = Math.min(dt, 0.2);
    clock += elapsed;
    for (const pool of Object.values(pools)) {
      for (let i = pool.particles.length - 1; i >= 0; i--) {
        const p = pool.particles[i];
        p.age += elapsed;
        if (p.age >= p.life) { pool.particles.splice(i, 1); continue; }
        if (pool.name === 'droplets' || pool.name === 'crumbs') {
          p.vy -= (reducedMotion ? 5 : 9) * elapsed;
          p.x += p.vx * elapsed; p.y += p.vy * elapsed; p.z += p.vz * elapsed;
          p.rx += p.spin * elapsed; p.rz += p.spin * elapsed * 0.7;
          const floor = floorAt(p.x, p.z);
          if (p.y < floor + 0.03) {
            if (pool.name === 'droplets') {
              stamp(p.x, p.z, p.size * random(1.65, 2.8), p.color, random(4.5, 7));
              pool.particles.splice(i, 1);
            } else {
              p.y = floor + 0.04;
              p.vy = Math.abs(p.vy) * 0.2;
              p.vx *= 0.55; p.vz *= 0.55; p.spin *= 0.5;
            }
          }
        } else if (pool.name === 'streaks') {
          p.x += p.vx * elapsed; p.y += p.vy * elapsed; p.z += p.vz * elapsed;
        }
      }
    }
    flush();
  }

  function reset() {
    for (const pool of Object.values(pools)) { pool.particles.length = 0; pool.mesh.count = 0; }
    clock = 0; lastImpact = -10;
  }

  return {
    impact(event) {
      // Cannon can report several same-frame fragment contacts. One full pop
      // every 45 ms retains the cascade while bounding screen coverage.
      if (clock - lastImpact < 0.045 || !normalize(event)) return;
      lastImpact = clock; burst(event);
    },
    ability(event) { burst(event, { ability: true }); },
    target(event) { burst({ strength: 1.15, kind: 'heavy', ...event }, { target: true }); },
    update,
    reset,
    dispose() {
      if (disposed) return;
      reset(); group.removeFromParent();
      for (const pool of Object.values(pools)) { pool.mesh.geometry.dispose(); pool.mesh.material.dispose(); pool.mesh.dispose(); }
      disposed = true;
    },
    get stats() {
      const counts = Object.fromEntries(Object.entries(pools).map(([name, pool]) => [name, pool.particles.length]));
      return { ...counts, active: Object.values(counts).reduce((sum, n) => sum + n, 0), capacity: Object.values(pools).reduce((sum, pool) => sum + pool.capacity, 0), drawCalls: Object.values(pools).filter(pool => pool.mesh.count > 0).length, reducedMotion, disposed };
    },
  };
}
