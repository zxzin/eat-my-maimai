import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const palette = {
  paving: '#e4d1ae', cream: '#fff2cc', sand: '#d6ba83', yellow: '#ffbc0d',
  red: '#cf3430', ink: '#30483f', soil: '#6d6541', trunk: '#987451',
  leaf: '#5d9958', leafLight: '#8db76a', leafDark: '#41794f',
};

/** A warm, toy-like town square; every prop sits outside the playable food footprint. */
export function createFoodPlaza({ scene, anisotropy = 1 }) {
  const plaza = new THREE.Group();
  plaza.name = 'food-plaza';
  const canvas = (width, height) => {
    const element = document.createElement('canvas');
    element.width = width; element.height = height;
    return [element, element.getContext('2d')];
  };
  const texture = element => {
    const map = new THREE.CanvasTexture(element);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = Math.max(1, anisotropy);
    return map;
  };
  const [sky, skyContext] = canvas(32, 512);
  const skyGradient = skyContext.createLinearGradient(0, 0, 0, 512);
  skyGradient.addColorStop(0, '#58b9cf');
  skyGradient.addColorStop(.5, '#b5e0dd');
  skyGradient.addColorStop(1, '#fff0cb');
  skyContext.fillStyle = skyGradient; skyContext.fillRect(0, 0, 32, 512);
  scene.background = texture(sky);
  scene.fog = new THREE.Fog('#d5e3ce', 38, 88);

  // One instanced draw per shape keeps the landscaped street cheap on mobile.
  const shapeGeometry = {
    box: new RoundedBoxGeometry(1, 1, 1, 1, .045),
    sphere: new THREE.SphereGeometry(1, 18, 12),
    cylinder: new THREE.CylinderGeometry(1, 1, 1, 18),
    cone: new THREE.ConeGeometry(1, 1, 4),
  };
  const batches = new Map();
  function prop(shape, color, position, scale, rotation = [0, 0, 0], style = 'solid') {
    const key = `${shape}:${style}`;
    if (!batches.has(key)) batches.set(key, { shape, style, items: [] });
    batches.get(key).items.push({ color, position, scale, rotation });
  }
  const block = (color, x, y, z, w, h, d, rotation) => prop('box', color, [x, y, z], [w, h, d], rotation);
  const orb = (color, x, y, z, sx, sy = sx, sz = sx, style = 'solid') => prop('sphere', color, [x, y, z], [sx, sy, sz], undefined, style);
  function tube(color, start, end, radius) {
    const a = new THREE.Vector3(...start), b = new THREE.Vector3(...end);
    const delta = b.clone().sub(a), rotation = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.clone().normalize()),
    );
    prop('cylinder', color, a.add(b).multiplyScalar(.5).toArray(), [radius, delta.length(), radius], rotation.toArray().slice(0, 3));
  }
  function plane(map, width, depth, x, y, z, { transparent = false, color = '#ffffff' } = {}) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshStandardMaterial({ map, color, roughness: .98, transparent, depthWrite: !transparent }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, y, z); mesh.receiveShadow = true;
    plaza.add(mesh); return mesh;
  }

  // Quiet sandstone brickwork has variation and mortar, without a noisy grid.
  const [paving, pavingContext] = canvas(1024, 1024);
  pavingContext.fillStyle = '#c5b994'; pavingContext.fillRect(0, 0, 1024, 1024);
  const paverColors = ['#e3d4b5', '#e9dabc', '#ded0b2', '#e6d7b8', '#e1d2af'];
  for (let row = 0; row < 8; row++) for (let col = -1; col < 5; col++) {
    const x = col * 256 + (row % 2) * 128, y = row * 128;
    pavingContext.fillStyle = paverColors[(row * 3 + col + 5) % paverColors.length];
    pavingContext.fillRect(x + 3, y + 3, 250, 122);
    pavingContext.fillStyle = 'rgba(255,255,255,.18)'; pavingContext.fillRect(x + 5, y + 5, 246, 2);
    pavingContext.fillStyle = 'rgba(116,96,62,.08)'; pavingContext.fillRect(x + 5, y + 122, 246, 2);
  }
  const pavingMap = texture(paving); pavingMap.wrapS = pavingMap.wrapT = THREE.RepeatWrapping; pavingMap.repeat.set(32, 32);
  plane(pavingMap, 160, 160, 0, -.06, 0);

  // The restaurant platform retains its gameplay height and exact usable footprint.
  block('#f3e5c5', 0, 0, 0, 15, .2, 8);
  block('#cf3430', 0, -.018, 4.04, 15.12, .12, .12);
  block('#ffe0a1', 0, .035, 4.12, 15.18, .055, .11);
  block('#d1ba8d', -7.5, -.005, 0, .09, .13, 8.1);
  block('#d1ba8d', 7.5, -.005, 0, .09, .13, 8.1);
  // Small brass insets and seams add craft to the stage apron.
  for (let x = -6.5; x <= 6.5; x += 1) {
    block('#dfccaa', x, .102, 3.35, .018, .003, 1.3);
    if (Math.abs(x) > 2) block('#e7bc55', x, .106, 3.85, .19, .008, .08);
  }
  block('#dfccaa', 0, .102, 2.7, 14.8, .003, .018);

  // A graphic assembly marker and a short golden approach guide the eye to the door.
  const [marker, markerContext] = canvas(1024, 1024);
  markerContext.strokeStyle = '#bd9a56'; markerContext.lineWidth = 8;
  markerContext.beginPath(); markerContext.arc(512, 512, 460, 0, Math.PI * 2); markerContext.stroke();
  markerContext.strokeStyle = '#f2b826'; markerContext.lineWidth = 28;
  markerContext.beginPath(); markerContext.arc(512, 512, 420, -.42, Math.PI * .74); markerContext.stroke();
  markerContext.beginPath(); markerContext.arc(512, 512, 420, Math.PI - .42, Math.PI * 1.74); markerContext.stroke();
  markerContext.fillStyle = '#bf9950';
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6, x = 512 + Math.cos(a) * 370, y = 512 + Math.sin(a) * 370;
    markerContext.save(); markerContext.translate(x, y); markerContext.rotate(a); markerContext.fillRect(-14, -4, 28, 8); markerContext.restore();
  }
  markerContext.fillStyle = '#efbb36';
  markerContext.beginPath(); markerContext.moveTo(512, 275); markerContext.lineTo(665, 465); markerContext.lineTo(566, 465);
  markerContext.lineTo(566, 692); markerContext.lineTo(458, 692); markerContext.lineTo(458, 465); markerContext.lineTo(359, 465); markerContext.closePath(); markerContext.fill();
  plane(texture(marker), 4.2, 4.2, 0, -.049, 7.2, { transparent: true });
  for (let z = 4.5; z < 6; z += .56) {
    block(palette.yellow, -.22, -.044, z, .58, .012, .13, [0, -.42, 0]);
    block(palette.yellow, .22, -.044, z, .58, .012, .13, [0, .42, 0]);
  }
  // A subtle pair of approach lanes leaves the central stage uncluttered.
  for (const side of [-1, 1]) {
    block('#d7bf8b', side * 6.5, -.048, 7.4, .08, .012, 6.6);
    block('#e4bd58', side * 6.7, -.047, 7.4, .045, .014, 6.6);
  }

  // Planters and stylized split-trunk trees frame the food silhouettes from the sides.
  for (const side of [-1, 1]) {
    const x = side * 9.15;
    block('#617f65', x, .32, -.8, 2.6, .72, 3.6);
    block('#e6cb88', x, .73, -.8, 2.72, .12, 3.72);
    block('#76865b', x, .8, -.8, 2.42, .04, 3.4);
    tube(palette.trunk, [x, .78, -1.55], [x - side * .1, 2.8, -1.55], .16);
    tube(palette.trunk, [x, 2.08, -1.55], [x + side * .73, 2.92, -1.7], .095);
    tube(palette.trunk, [x, 2.26, -1.55], [x - side * .62, 2.97, -1.35], .09);
    orb(palette.leafDark, x + .12, 3.06, -1.68, 1.22, .99, 1.02);
    orb(palette.leaf, x - side * .6, 3.35, -1.47, .92, 1.05, .88);
    orb(palette.leafLight, x + side * .5, 3.69, -1.57, .82, .91, .79);
    for (let i = 0; i < 5; i++) {
      const z = .43 - i * .43;
      orb(i % 2 ? '#95b56b' : '#699455', x + side * .68, 1.02, z, .32, .28, .36);
      if (i % 2 === 0) orb('#f5d678', x + side * .7, 1.23, z + .08, .1, .1, .08);
    }
    // Modest warm lamps and rounded bollards give the square human scale.
    const lx = side * 8.6, lz = 3.1;
    tube('#536857', [lx, -.04, lz], [lx, 3.38, lz], .065);
    prop('cylinder', '#596a55', [lx, .08, lz], [.22, .24, .22]);
    prop('cylinder', '#f7df9a', [lx, 3.48, lz], [.22, .28, .22], undefined, 'lamp');
    prop('cylinder', '#4f6955', [lx, 3.65, lz], [.33, .09, .33]);
    for (const z of [5.1, 7.25, 9.4]) {
      prop('cylinder', '#c8aa6a', [side * 7.55, .28, z], [.115, .66, .115]);
      orb('#f0ce77', side * 7.55, .64, z, .135);
    }
  }

  // A deliberately asymmetric street: little shopfronts, pitched roofs and awnings.
  const houses = [
    [-23, -23, 5.5, 4.1, '#a5bdb0', '#7c9e91'], [-17, -19, 4.7, 5.3, '#d4c8a5', '#a5b796'],
    [-11.6, -17.5, 4.3, 3.5, '#b5c9b6', '#7fa28c'], [-6.7, -21, 4.5, 4.7, '#d4c2a5', '#a7b6a4'],
    [-1.1, -24, 4.9, 3.6, '#b9c8b0', '#92aaa0'], [5.2, -22.5, 4.5, 4.3, '#b2c9c3', '#86aaa3'],
    [10.8, -18.5, 4.1, 5.1, '#d8cfb0', '#9fb9a3'], [16.5, -21, 5.2, 3.8, '#b6c9bb', '#86a696'],
    [23, -24, 5.5, 4.9, '#d3c8ae', '#9eb0a0'],
  ];
  houses.forEach(([x, z, w, h, wall, roof], index) => {
    block(wall, x, h / 2 - .04, z, w, h, 3.3);
    block('#e2dec8', x, h + .025, z, w + .18, .17, 3.48);
    if (index % 3 === 1) {
      // Low pyramidal roofs soften the skyline without creating a second focal point.
      prop('cone', roof, [x, h + .72, z], [w * .72, 1.35, 2.3], [0, Math.PI / 4, 0]);
    } else {
      block(roof, x, h + .25, z, w + .32, .28, 3.62);
      block('#dbd9bf', x - w * .29, h + .61, z - .5, .56, .58, .63);
    }
    const front = z + 1.69;
    for (let col = -1; col <= 1; col++) {
      block('#e8e2cb', x + col * w * .25, h - 1.07, front, .69, 1.12, .11);
      block('#789c92', x + col * w * .25, h - 1.07, front + .066, .53, .91, .035);
      block('#cbd3bb', x + col * w * .25, h - 1.07, front + .09, .035, .91, .025);
    }
    block('#76968c', x, .75, front, w * .64, 1.45, .08);
    block('#d9d6b9', x, .74, front + .06, .06, 1.45, .04);
    for (let stripe = 0; stripe < 7; stripe++) {
      block(stripe % 2 ? '#e5dfc1' : index % 2 ? '#a2b1a0' : '#c7b77b', x + (stripe - 3) * w * .105, 1.7, front + .31, w * .105, .12, .74, [.16, 0, 0]);
    }
    block('#c9c4a6', x, -.005, front + .54, w + .35, .08, 1.12);
  });

  // Soft, distant foliage hides the repeating street edge; hills give the sky depth.
  for (let i = 0; i < 12; i++) {
    const x = (i - 5.5) * 4.7, z = -30 - (i % 3) * 2.1;
    orb(i % 2 ? '#adc8a4' : '#9fbd9d', x, .9, z, 3.35, 2.1 + (i % 3) * .5, 2.6, 'distant');
  }
  orb('#c9d9b7', -24, -.5, -46, 22, 12, 13, 'distant');
  orb('#b4cda9', 22, -1.5, -42, 25, 13, 12, 'distant');
  orb('#d3dfbe', 0, -4, -57, 27, 15, 14, 'distant');

  // Small airy clouds use a matte unlit surface, avoiding bright specular balloons.
  for (const [x, y, z, s] of [[-20, 12.4, -32, 1.1], [18, 13.8, -36, 1.3], [3, 16.5, -44, .9]]) {
    orb('#fff7df', x, y, z, 2.5 * s, .58 * s, .8 * s, 'cloud');
    orb('#fff8e6', x - .9 * s, y + .45 * s, z, .88 * s, .72 * s, .72 * s, 'cloud');
    orb('#fff8e6', x + .42 * s, y + .64 * s, z - .1, 1.1 * s, .92 * s, .88 * s, 'cloud');
  }

  const dummy = new THREE.Object3D(), color = new THREE.Color();
  for (const [key, batch] of batches) {
    const material = batch.style === 'cloud' || batch.style === 'distant'
      ? new THREE.MeshBasicMaterial({ color: '#ffffff' })
      : new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .9, ...(batch.style === 'lamp' ? { emissive: '#edc367', emissiveIntensity: .35 } : {}) });
    const mesh = new THREE.InstancedMesh(shapeGeometry[batch.shape], material, batch.items.length);
    mesh.name = `plaza-${key}`;
    batch.items.forEach((item, index) => {
      dummy.position.set(...item.position); dummy.scale.set(...item.scale); dummy.rotation.set(...item.rotation); dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix); mesh.setColorAt(index, color.set(item.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.receiveShadow = batch.style === 'solid';
    mesh.castShadow = batch.style === 'solid';
    mesh.computeBoundingSphere(); plaza.add(mesh);
  }
  plaza.userData.environment = { version: 'food-plaza-v1', meshCount: plaza.children.length, platformTop: .1, groundY: -.06 };
  scene.add(plaza);
  return plaza;
}
