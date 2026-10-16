import * as THREE from 'three';

const DAMAGE = Object.freeze({ corn: 1, bun: 3, ketchup: 3, patty: 5, onion: 3, sausage: 4, fry: 3, nugget: 4, burgerbomb: 10 });
const MAX_CHIPS = 48, MAX_CRACKS = 36, FALL_TIME = 1.3;
const front = new THREE.Vector3(0, 0, 1), flashColor = new THREE.Color('#ffe8a0'), glowColor = new THREE.Color('#b65b12');
const finiteVector = value => value && [value.x, value.y, value.z].every(Number.isFinite);
const vector = value => new THREE.Vector3(value.x, value.y, value.z);
const plain = value => ({ x: value.x, y: value.y, z: value.z });
const hash = text => [...String(text)].reduce((n, char) => Math.imul(n ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);

/** Structural durability is separate from food matches and their coin rewards. */
export function buildingAmmoDamage(ammo) {
  return DAMAGE[typeof ammo === 'string' ? ammo : ammo?.id] ?? 0;
}

// Broad triangular strokes remain legible on a phone; the mesh needs no texture.
function fractureGeometry(strokeWidth) {
  const positions = [];
  const paths = [
    [[0, 0], [-.11, .12], [-.08, .24], [-.22, .37]],
    [[0, 0], [.13, .04], [.22, -.02], [.37, .08]],
    [[0, 0], [-.04, -.15], [.05, -.24], [.01, -.4]],
    [[-.08, .24], [.04, .3], [.08, .41]],
    [[-.04, -.15], [-.19, -.19], [-.28, -.3]],
  ];
  for (const path of paths) for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1], [bx, by] = path[i];
    const length = Math.hypot(bx - ax, by - ay), width = strokeWidth * (1 - (i - 1) * .17);
    const nx = -(by - ay) / length * width, ny = (bx - ax) / length * width;
    positions.push(ax + nx, ay + ny, 0, ax - nx, ay - ny, 0, bx + nx, by + ny, 0,
      ax - nx, ay - ny, 0, bx - nx, by - ny, 0, bx + nx, by + ny, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); return geometry;
}

/**
 * Owns structural cracks and gravity-driven rubble. Food, coins and objectives
 * stay with the caller. Call update only while gameplay is running.
 *
 * Parts are {id, zone, label, mesh, maxHp}. Meshes keep their original resources;
 * dispose restores their transforms/materials and releases only owned resources.
 */
export function createBuildingDamage({ scene, parts = [], reducedMotion = false, onImpact = () => {} } = {}) {
  if (!scene?.isObject3D) throw new TypeError('Building damage requires a Three.js scene');
  const records = new Map(), chips = [], cracks = [];
  const crackGeometry = fractureGeometry(.025), crackEdgeGeometry = fractureGeometry(.055), chipGeometry = new THREE.BoxGeometry(1, 1, 1);
  const crackDark = new THREE.MeshBasicMaterial({ color: '#34100b', side: THREE.DoubleSide, depthWrite: false });
  const crackEdge = new THREE.MeshBasicMaterial({ color: '#fff5d6', side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
  const chipMaterials = ['#c71d16', '#fff3ce', '#ffbf25'].map(color => new THREE.MeshStandardMaterial({ color, roughness: .85 }));
  let disposed = false, finalStarted = false;

  for (const part of parts) {
    if (part?.id === undefined || records.has(part.id) || !part.mesh?.isObject3D) continue;
    const mesh = part.mesh, maxHp = Number.isSafeInteger(part.maxHp) && part.maxHp > 0 ? part.maxHp : 12;
    mesh.updateWorldMatrix(true, true);
    const tags = [], originals = [];
    mesh.traverse(child => {
      if (!child.isMesh) return;
      tags.push({ child, had: Object.hasOwn(child.userData, 'structureId'), value: child.userData.structureId });
      child.userData.structureId = part.id;
      originals.push({ child, material: child.material, owned: null });
    });
    records.set(part.id, {
      id: part.id, zone: part.zone || 'facade', label: part.label || '餐厅墙体', mesh, maxHp, hp: maxHp,
      status: 'intact', original: { parent: mesh.parent, position: mesh.position.clone(), quaternion: mesh.quaternion.clone(), scale: mesh.scale.clone(), visible: mesh.visible },
      tags, originals, cracks: [], crackLevel: 0, flash: 0, delay: 0, elapsed: 0,
      seed: hash(part.id), recoil: new THREE.Vector3(), motion: null,
    });
  }

  function ownedMaterials(record) {
    for (const item of record.originals) {
      if (!item.owned) {
        item.owned = Array.isArray(item.material) ? item.material.map(material => material.clone()) : item.material.clone();
        item.child.material = item.owned;
      }
    }
  }
  function tint(record, amount) {
    if (!record.originals.some(item => item.owned)) return;
    for (const item of record.originals) {
      const base = Array.isArray(item.material) ? item.material : [item.material];
      const current = Array.isArray(item.owned) ? item.owned : [item.owned];
      current.forEach((material, i) => {
        if (material?.color && base[i]?.color) material.color.copy(base[i].color).lerp(flashColor, amount);
        if (material?.emissive && base[i]?.emissive) material.emissive.copy(base[i].emissive).lerp(glowColor, amount * .3);
      });
    }
  }
  function worldBounds(record) {
    record.mesh.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3();
    // Only the original rendered geometry defines a structural surface. Decals
    // never enlarge its targeting, explosion radius or final landing height.
    for (const { child } of record.originals) {
      if (child.isInstancedMesh) {
        if (!child.boundingBox) child.computeBoundingBox();
        bounds.union(child.boundingBox.clone().applyMatrix4(child.matrixWorld));
      } else if (child.geometry) {
        if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
        bounds.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
      }
    }
    return bounds;
  }
  // Instanced trim can have an origin at ground level; its visible bounds give
  // the correct support-to-roof ordering and impact location.
  function center(record) { return worldBounds(record).getCenter(new THREE.Vector3()); }
  function removeCrack(entry) {
    entry.group.removeFromParent();
    const index = cracks.indexOf(entry); if (index >= 0) cracks.splice(index, 1);
    const localIndex = entry.record.cracks.indexOf(entry); if (localIndex >= 0) entry.record.cracks.splice(localIndex, 1);
  }
  function addCrack(record, point, normal) {
    if (record.cracks.length >= 3) return;
    while (cracks.length >= MAX_CRACKS) removeCrack(cracks[0]);
    const group = new THREE.Group(), edge = new THREE.Mesh(crackEdgeGeometry, crackEdge), dark = new THREE.Mesh(crackGeometry, crackDark);
    edge.userData.structureId = dark.userData.structureId = record.id;
    edge.position.z = -.002; dark.position.z = .004;
    edge.renderOrder = 2; dark.renderOrder = 3;
    group.add(edge, dark); group.name = `structure-crack-${record.id}`;
    // Find the real struck instance instead of using the whole awning batch's
    // envelope, which contains air between individual strips.
    let surface;
    for (const { child } of record.originals) {
      if (!child.geometry?.boundingBox) child.geometry?.computeBoundingBox();
      if (!child.geometry?.boundingBox) continue;
      const count = child.isInstancedMesh ? child.count : 1;
      for (let index = 0; index < count; index++) {
        const matrix = child.matrixWorld.clone();
        if (child.isInstancedMesh) { const instance = new THREE.Matrix4(); child.getMatrixAt(index, instance); matrix.multiply(instance); }
        const box = child.geometry.boundingBox;
        const distance = box.clone().applyMatrix4(matrix).distanceToPoint(point);
        if (!surface || distance < surface.distance) surface = { matrix, box, distance, curved: /Torus|Cylinder/.test(child.geometry.type) };
      }
    }
    if (!surface) return;
    const inverse = surface.matrix.clone().invert(), localPoint = point.clone().applyMatrix4(inverse);
    const localNormal = normal.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(surface.matrix).transpose()).normalize();
    const axis = ['x', 'y', 'z'].sort((a, b) => Math.abs(localNormal[b]) - Math.abs(localNormal[a]))[0];
    const faceNormal = new THREE.Vector3(); faceNormal[axis] = Math.sign(localNormal[axis]) || 1;
    const vertical = axis === 'y' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const right = vertical.clone().cross(faceNormal).normalize(), upright = faceNormal.clone().cross(right).normalize();
    const projectRange = direction => {
      const a = direction.dot(surface.box.min), b = direction.dot(surface.box.max);
      return [Math.min(a, b), Math.max(a, b)];
    };
    const [minU, maxU] = projectRange(right), [minV, maxV] = projectRange(upright);
    const worldLength = direction => direction.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(surface.matrix)).length();
    const desired = surface.curved ? .17 : .85 + (1 - record.hp / record.maxHp) * .65;
    const pattern = crackEdgeGeometry.boundingBox, patternSize = pattern.getSize(new THREE.Vector3());
    const marginU = (maxU - minU) * .08, marginV = (maxV - minV) * .08;
    const scaleU = Math.min(desired / worldLength(right), (maxU - minU - 2 * marginU) / patternSize.x);
    const scaleV = Math.min(desired / worldLength(upright), (maxV - minV - 2 * marginV) / patternSize.y);
    const u = THREE.MathUtils.clamp(localPoint.dot(right), minU + marginU - pattern.min.x * scaleU, maxU - marginU - pattern.max.x * scaleU);
    const v = THREE.MathUtils.clamp(localPoint.dot(upright), minV + marginV - pattern.min.y * scaleV, maxV - marginV - pattern.max.y * scaleV);
    const localPosition = right.clone().multiplyScalar(u).addScaledVector(upright, v);
    localPosition[axis] = faceNormal[axis] > 0 ? surface.box.max[axis] : surface.box.min[axis];
    const basis = new THREE.Matrix4().makeBasis(right, upright, faceNormal);
    basis.setPosition(localPosition);
    const matrix = surface.matrix.clone().multiply(basis).multiply(new THREE.Matrix4().makeScale(scaleU, scaleV, 1));
    matrix.decompose(group.position, group.quaternion, group.scale);
    group.position.addScaledVector(normal, .018);
    scene.add(group); scene.updateMatrixWorld(true); record.mesh.attach(group);
    const entry = { group, record }; record.cracks.push(entry); cracks.push(entry);
  }
  function spawnChips(record, point, normal, amount = 2) {
    if (reducedMotion) amount = Math.min(1, amount);
    for (let i = 0; i < amount; i++) {
      if (chips.length >= MAX_CHIPS) { chips[0].mesh.removeFromParent(); chips.shift(); }
      const n = ((record.seed + i * 719 + Math.round(record.hp * 143)) % 997) / 997;
      const mesh = new THREE.Mesh(chipGeometry, chipMaterials[(record.seed + i) % chipMaterials.length]);
      const size = .055 + n * .08; mesh.scale.set(size, size * .7, size * .6); mesh.position.copy(point).addScaledVector(normal, .035);
      mesh.rotation.set(n * 2, n * 4, n * 3); mesh.castShadow = true; scene.add(mesh);
      chips.push({ mesh, age: 0, life: reducedMotion ? .35 : .6 + n * .5, velocity: normal.clone().multiplyScalar(.6 + n).add(new THREE.Vector3((n - .5) * 1.5, 1.1 + n, (n - .5) * .8)), spin: (n - .5) * 8 });
    }
  }
  function notify(record, { point, normal, damage, destroyed, cause }) {
    onImpact({ partId: record.id, zone: record.zone, point: point.clone(), normal: normal.clone(), damage, destroyed, label: record.label, cause });
  }
  function queue(record, delay, cause) {
    if (record.status !== 'intact') return false;
    record.hp = 0; record.status = 'queued'; record.delay = delay; record.elapsed = 0; record.cause = cause;
    return true;
  }
  function damage(record, amount, point, normal, cause) {
    const inflicted = Math.min(amount, record.hp);
    record.hp -= inflicted; record.flash = 1;
    ownedMaterials(record); tint(record, .75);
    // Recoil remains short and returns to the original transform each frame.
    record.recoil.copy(normal).multiplyScalar(-.035);
    const level = Math.min(3, Math.ceil((1 - record.hp / record.maxHp) * 3));
    if (level > record.crackLevel) { addCrack(record, point, normal); record.crackLevel = level; }
    spawnChips(record, point, normal, amount === 1 ? 1 : 3);
    const destroyed = record.hp === 0;
    if (destroyed) queue(record, 0, cause);
    notify(record, { point, normal, damage: inflicted, destroyed, cause });
    return inflicted;
  }
  function beginFall(record) {
    // Reparenting preserves the world transform and isolates rubble from later
    // restaurant-group effects. The original parent is restored on dispose.
    record.mesh.position.copy(record.original.position);
    record.mesh.updateWorldMatrix(true, true); scene.attach(record.mesh);
    const mesh = record.mesh, start = mesh.position.clone(), startQuaternion = mesh.quaternion.clone(), startScale = mesh.scale.clone();
    const bounds = worldBounds(record), dimensions = bounds.getSize(new THREE.Vector3()), surfaceCenter = bounds.getCenter(new THREE.Vector3());
    const seed = record.seed, side = start.x < -.3 ? -1 : start.x > .3 ? 1 : (seed % 2 ? 1 : -1);
    const n = (seed % 997) / 997;
    const isWall = dimensions.y > Math.min(dimensions.x, dimensions.z) * 1.8 && dimensions.y > .8;
    const fallAcrossWidth = isWall && dimensions.x < dimensions.z;
    const rotation = new THREE.Euler(fallAcrossWidth ? 0 : isWall ? -Math.PI / 2 + (n - .5) * .15 : (n - .5) * .65,
      (n - .5) * .45, fallAcrossWidth ? side * (Math.PI / 2 + (n - .5) * .1) : side * (.13 + n * .14));
    const finishQuaternion = new THREE.Quaternion().setFromEuler(rotation).multiply(startQuaternion);
    const finish = start.clone().add(new THREE.Vector3(side * (.18 + n * .55), 0, .3 + n * .65));
    const finishScale = startScale.clone().multiplyScalar(.78 + n * .1);
    mesh.position.copy(finish); mesh.quaternion.copy(finishQuaternion); mesh.scale.copy(finishScale); mesh.updateWorldMatrix(true, true);
    const bottom = worldBounds(record).min.y;
    finish.y += .15 - bottom + (seed % 4) * .035;
    mesh.position.copy(start); mesh.quaternion.copy(startQuaternion); mesh.scale.copy(startScale);
    record.motion = { start, startQuaternion, startScale, finish, finishQuaternion, finishScale };
    record.status = 'falling'; record.elapsed = 0;
    if (record.cause === 'mechanism' || record.cause === 'final') {
      const point = surfaceCenter, normal = front.clone();
      spawnChips(record, point, normal, 2);
      notify(record, { point, normal, damage: 0, destroyed: true, cause: record.cause });
    }
  }
  function fall(record, dt) {
    record.elapsed += dt;
    const duration = reducedMotion ? .32 : FALL_TIME, progress = Math.min(1, record.elapsed / duration), motion = record.motion;
    const gravity = progress * progress;
    record.mesh.position.lerpVectors(motion.start, motion.finish, gravity);
    record.mesh.quaternion.slerpQuaternions(motion.startQuaternion, motion.finishQuaternion, Math.min(1, progress * 1.15));
    record.mesh.scale.lerpVectors(motion.startScale, motion.finishScale, progress);
    // A small damped landing bounce reads as weight without a floating burst.
    if (!reducedMotion && progress > .8) record.mesh.position.y += Math.sin((progress - .8) / .2 * Math.PI) * .075;
    if (progress >= 1) {
      record.mesh.position.copy(motion.finish); record.mesh.quaternion.copy(motion.finishQuaternion); record.mesh.scale.copy(motion.finishScale);
      record.status = 'rubble'; record.flash = 0; tint(record, 0);
    }
  }

  return {
    hit({ partId, ammo, point, normal } = {}) {
      const record = records.get(partId), amount = buildingAmmoDamage(ammo);
      if (disposed || !record || record.status !== 'intact' || !amount || (point && !finiteVector(point)) || (normal && (!finiteVector(normal) || vector(normal).lengthSq() < 1e-10)))
        return { hit: false, damage: 0, destroyed: false, label: '', remaining: record?.hp ?? 0, affectedIds: [] };
      const contact = point ? vector(point) : worldBounds(record).getCenter(new THREE.Vector3());
      const direction = normal ? vector(normal).normalize() : front.clone();
      const inflicted = damage(record, amount, contact, direction, 'direct'), affectedIds = [record.id];
      if ((typeof ammo === 'string' ? ammo : ammo.id) === 'burgerbomb') {
        const nearby = [...records.values()].filter(other => other !== record && other.status === 'intact')
          .map(other => ({ other, distance: worldBounds(other).distanceToPoint(contact) }))
          .filter(({ distance }) => distance <= 2.35).sort((a, b) => a.distance - b.distance).slice(0, 8);
        for (const { other } of nearby) {
          const otherContact = worldBounds(other).clampPoint(contact, new THREE.Vector3());
          damage(other, 8, otherContact, direction, 'blast'); affectedIds.push(other.id);
        }
      }
      return { hit: true, damage: inflicted, destroyed: record.hp === 0, label: record.label, remaining: record.hp, affectedIds };
    },
    collapseZone(zone) {
      if (disposed) return { count: 0, duration: 0 };
      const matching = [...records.values()].filter(record => record.zone === zone && record.status === 'intact')
        .sort((a, b) => center(a).y - center(b).y || String(a.id).localeCompare(String(b.id)));
      matching.forEach((record, index) => queue(record, reducedMotion ? 0 : index / Math.max(1, matching.length - 1) * .6, 'mechanism'));
      return { count: matching.length, duration: matching.length ? (reducedMotion ? .32 : 1.9) : 0 };
    },
    collapseAll() {
      if (disposed || finalStarted) return { count: 0, duration: 0 };
      finalStarted = true;
      const matching = [...records.values()].filter(record => record.status === 'intact')
        .sort((a, b) => center(a).y - center(b).y || String(a.id).localeCompare(String(b.id)));
      matching.forEach((record, index) => queue(record, reducedMotion ? 0 : index / Math.max(1, matching.length - 1) * 1.1, 'final'));
      return { count: matching.length, duration: matching.length ? (reducedMotion ? .32 : 2.4) : 0 };
    },
    update(dt) {
      if (disposed || !Number.isFinite(dt) || dt <= 0) return;
      // Split large steps so the same pause/resume behavior applies at low FPS.
      let remaining = Math.min(dt, 3);
      while (remaining > 1e-8) {
        const step = Math.min(remaining, .05); remaining -= step;
        for (const record of records.values()) {
          if (record.flash > 0) { record.flash = Math.max(0, record.flash - step * 8); tint(record, record.flash * .75); }
          if (record.status === 'intact') {
            record.recoil.multiplyScalar(Math.exp(-step * 24));
            record.mesh.position.copy(record.original.position).add(record.recoil);
          } else if (record.status === 'queued') {
            record.delay -= step;
            if (record.delay <= 1e-8) { const overflow = Math.max(0, -record.delay); beginFall(record); if (overflow) fall(record, overflow); }
          } else if (record.status === 'falling') fall(record, step);
        }
        for (let i = chips.length - 1; i >= 0; i--) {
          const chip = chips[i]; chip.age += step;
          if (chip.age >= chip.life) { chip.mesh.removeFromParent(); chips.splice(i, 1); continue; }
          chip.velocity.y -= 8 * step; chip.mesh.position.addScaledVector(chip.velocity, step); chip.mesh.rotation.x += chip.spin * step; chip.mesh.rotation.z += chip.spin * step;
          if (chip.mesh.position.y < .16) { chip.mesh.position.y = .16; chip.velocity.y = Math.abs(chip.velocity.y) * .15; chip.velocity.multiplyScalar(.6); }
        }
      }
    },
    get targets() { return disposed ? [] : [...records.values()].filter(record => record.status === 'intact' && record.hp > 0 && record.mesh.visible).map(record => record.mesh); },
    get state() {
      const snapshot = [...records.values()].map(record => ({ id: record.id, zone: record.zone, label: record.label, hp: record.hp, maxHp: record.maxHp,
        status: record.status, position: plain(center(record)), crackLevel: record.crackLevel, crackCount: record.cracks.length,
        collidable: !disposed && record.status === 'intact' && record.hp > 0 && record.mesh.visible,
        collapseProgress: record.status === 'rubble' ? 1 : record.status === 'falling' ? Math.min(1, record.elapsed / (reducedMotion ? .32 : FALL_TIME)) : 0 }));
      return { total: snapshot.length, intact: snapshot.filter(part => part.status === 'intact').length,
        damaged: snapshot.filter(part => part.hp < part.maxHp && part.hp > 0).length, destroyed: snapshot.filter(part => part.hp === 0).length,
        falling: snapshot.filter(part => part.status === 'falling').length, rubble: snapshot.filter(part => part.status === 'rubble').length,
        cracks: cracks.length, debris: chips.length, disposed, parts: snapshot };
    },
    dispose() {
      if (disposed) return; disposed = true;
      for (const chip of chips) chip.mesh.removeFromParent(); chips.length = 0;
      for (const entry of [...cracks]) removeCrack(entry);
      for (const record of records.values()) {
        const { mesh, original } = record;
        if (original.parent) original.parent.add(mesh); else mesh.removeFromParent();
        mesh.position.copy(original.position); mesh.quaternion.copy(original.quaternion); mesh.scale.copy(original.scale); mesh.visible = original.visible;
        for (const item of record.originals) {
          item.child.material = item.material;
          if (item.owned) for (const material of Array.isArray(item.owned) ? item.owned : [item.owned]) material.dispose();
        }
        for (const tag of record.tags) { if (tag.had) tag.child.userData.structureId = tag.value; else delete tag.child.userData.structureId; }
      }
      crackGeometry.dispose(); crackEdgeGeometry.dispose(); chipGeometry.dispose(); crackDark.dispose(); crackEdge.dispose(); for (const material of chipMaterials) material.dispose();
    },
  };
}
