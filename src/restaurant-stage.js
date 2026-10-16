import * as THREE from 'three';
import { createFood } from './food-models.js';

const materials = new Map();
const geometries = new Map();
const material = (color, roughness = .58) => {
  const key = `${color}:${roughness}`;
  if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color, roughness }));
  return materials.get(key);
};
const geometry = (key, make) => {
  if (!geometries.has(key)) geometries.set(key, make());
  return geometries.get(key);
};
const colors = { red: '#ce211b', darkRed: '#8f1619', white: '#fffaf0', yellow: '#ffbc0d', ink: '#253438', steel: '#8a9e9f' };

/** A restaurant made of food, with three readable physical chain reactions. */
export function buildRestaurantStage({ castle, addNode, box, sign, seed = 1 }) {
  const decor = [], setpieces = [], structureParts = [];
  const buckets = new Map(['bucket', 'fries', 'sauce'].map(id => [id, []]));
  let randomState = Number.isFinite(seed) ? seed >>> 0 : 1;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
  function prop(mesh, setpiece) {
    mesh.castShadow = mesh.receiveShadow = true;
    if (setpiece) { mesh.userData.setpiece = setpiece; buckets.get(setpiece).push(mesh); }
    castle.add(mesh); decor.push(mesh); return mesh;
  }
  function structure(mesh, zone, label, maxHp = 12) {
    const id = `structure-${zone}-${structureParts.length}`;
    mesh.userData.structureId = id;
    structureParts.push({ id, zone, label, mesh, maxHp });
    return mesh;
  }
  function wall(zone, label, maxHp, ...args) {
    return structure(block(...args), zone, label, maxHp);
  }
  function block(w, h, d, color, x, y, z, round = .04, setpiece) {
    return prop(box(w, h, d, color, x, y, z, round), setpiece);
  }
  function cylinder(radiusTop, radiusBottom, height, color, x, y, z, setpiece, open = false) {
    const key = `cylinder:${radiusTop}:${radiusBottom}:${height}:${open}`;
    const mesh = new THREE.Mesh(geometry(key, () => new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 32, 1, open)), material(color));
    mesh.position.set(x, y, z); return prop(mesh, setpiece);
  }
  function ring(radius, tube, color, x, y, z, setpiece, arc = Math.PI * 2) {
    const mesh = new THREE.Mesh(geometry(`ring:${radius}:${tube}:${arc}`, () => new THREE.TorusGeometry(radius, tube, 8, 40, arc)), material(color, .4));
    mesh.position.set(x, y, z); return prop(mesh, setpiece);
  }
  function pipe(start, end, radius, color, setpiece) {
    const a = new THREE.Vector3(...start), b = new THREE.Vector3(...end), delta = b.clone().sub(a);
    const mesh = new THREE.Mesh(geometry('unit-pipe', () => new THREE.CylinderGeometry(1, 1, 1, 16)), material(color, .4));
    mesh.position.copy(a).add(b).multiplyScalar(.5); mesh.scale.set(radius, delta.length(), radius);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    return prop(mesh, setpiece);
  }
  function batchBoxes(color, items, setpiece) {
    const mesh = new THREE.InstancedMesh(geometry('unit-box', () => new THREE.BoxGeometry(1, 1, 1)), material(color), items.length);
    const dummy = new THREE.Object3D();
    items.forEach(({ position, scale, rotation = [0, 0, 0] }, index) => {
      dummy.position.set(...position); dummy.scale.set(...scale); dummy.rotation.set(...rotation); dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix);
    });
    return prop(mesh, setpiece);
  }
  function food(kind, x, y, z, size = 1, rotation = 0, { setpiece, flat = false } = {}) {
    if (!setpiece) { x += (random() - .5) * .16; y += (random() - .5) * .07; z += (random() - .5) * .1; }
    const options = { supportless: true, ...(setpiece ? { setpiece } : {}) };
    if (['bun', 'patty', 'onion'].includes(kind)) {
      options.foodRotation = [flat ? 0 : Math.PI / 2, 0, 0];
      const thickness = kind === 'bun' ? .36 : kind === 'patty' ? .2 : .18;
      options.hitScale = flat ? [size * .9, size * thickness, size * .9] : [size * .9, size * .9, size * thickness];
    }
    return addNode(kind, x, y, z, size, rotation, options);
  }
  function foodProp(kind, x, y, z, scale, rotation = 0) {
    const model = createFood(kind); model.position.set(x, y, z); model.scale.setScalar(scale); model.rotation.z = rotation;
    return prop(model);
  }
  function chain(id, label, members, trigger, position, triggerRing) {
    const group = { id, label, triggerIds: [trigger.id], memberIds: members.map(node => node.id), position, decor: buckets.get(id), ring: triggerRing };
    setpieces.push(group); return group;
  }

  // A continuous foundation and deep shop interior establish ground and depth.
  castle.add(box(12.4, .28, 3.5, '#e7d6ac', 0, .14, .2, .09));
  block(6.3, .22, 2.75, colors.white, -.4, .38, -.15);
  wall('facade', '前厅红墙', 12, 6.3, 3.8, .28, colors.darkRed, -.4, 2.32, -1.3);
  wall('facade', '前厅橱窗', 8, 5.7, 2.85, .12, colors.ink, -.4, 2.27, -1.12);
  wall('facade', '左门柱', 10, .34, 3.75, 2.25, colors.red, -3.38, 2.25, -.2);
  wall('facade', '右门柱', 10, .34, 3.75, 2.25, colors.red, 2.58, 2.25, -.2);
  wall('facade', '窗框立柱', 8, .24, 3.15, .3, colors.white, -.02, 2.01, .05);
  wall('facade', '门头横梁', 10, 6.6, .48, 2.75, colors.red, -.4, 4.2, -.02, .09);
  wall('facade', '门头白边', 8, 6.7, .14, 2.85, colors.white, -.4, 4.5, -.02, .035);
  // The serving ledge projects toward the player, under the actual food stacks.
  wall('facade', '取餐台', 10, 6.45, .2, 1.0, colors.white, -.4, .65, 1.05, .06);
  wall('facade', '悬挑餐台', 8, 2.55, .18, .88, '#aa6a2c', 1.35, 2.17, .85, .035);
  wall('facade', '餐台金边', 8, 2.65, .12, .93, colors.yellow, 1.35, 2.28, .87, .025);
  const awningRed = [], awningWhite = [];
  for (let i = 0; i < 14; i++) {
    const x = -3.53 + i * .48, row = i % 2 ? awningWhite : awningRed;
    row.push({ position: [x, 3.89, 1.16], scale: [.48, .14, 1.25], rotation: [.17, 0, 0] });
    row.push({ position: [x, 3.72, 1.78], scale: [.48, .27, .09] });
  }
  structure(batchBoxes(colors.red, awningRed), 'facade', '红条遮阳棚', 8);
  structure(batchBoxes(colors.white, awningWhite), 'facade', '白条遮阳棚', 8);
  structure(prop(sign('KFB', 2.25, .7, -.65, 4.27, 1.47)), 'facade', '门头招牌', 8);
  // Narrow warm interior lights show that windows have depth.
  structure(batchBoxes('#ffe396', [
    { position: [-1.78, 3.15, -.97], scale: [1.8, .065, .04] },
    { position: [1.35, 3.12, -.97], scale: [1.65, .065, .04] },
  ]), 'facade', '窗内灯带', 8);

  // Rear wings turn the restaurant into a complete destination. Their dark
  // recesses sit behind the warm playable foods, keeping the aim silhouettes.
  for (const [x, width, top] of [[-4.6, 2.36, 4.62], [4.49, 2.34, 4.31]]) {
    const zone = x < 0 ? 'left-wing' : 'right-wing', label = x < 0 ? '左翼' : '右翼';
    wall(zone, `${label}红墙`, 12, width, top - .35, .42, colors.darkRed, x, (top + .35) / 2, -1.1);
    wall(zone, `${label}橱窗`, 8, width - .36, top - 1.1, .12, '#273b41', x, (top + .35) / 2, -.84);
    wall(zone, `${label}左柱`, 10, .18, top - .3, 1.4, colors.white, x - width / 2 + .09, (top + .3) / 2, -.52);
    wall(zone, `${label}右柱`, 10, .18, top - .3, 1.4, colors.white, x + width / 2 - .09, (top + .3) / 2, -.52);
    wall(zone, `${label}屋檐`, 8, width + .14, .22, 1.7, colors.red, x, top, -.52, .065);
    wall(zone, `${label}白边`, 8, width + .2, .08, 1.75, colors.white, x, top + .14, -.52, .025);
  }

  // The upper dining loft and tall, supported marquee give the central shop a
  // second skyline without spreading the targets beyond a phone-sized view.
  wall('loft', '二层地梁', 10, 3.55, .22, 2.04, colors.darkRed, -1.03, 5.03, -.48, .065);
  wall('loft', '二层白墙', 12, 3.24, 1.36, .35, colors.white, -1.03, 5.8, -1.03);
  wall('loft', '二层玻璃', 8, 2.78, .91, .08, '#243b40', -1.03, 5.86, -.8);
  structure(batchBoxes(colors.red, [
    { position: [-2.6, 5.78, -.28], scale: [.22, 1.53, 1.54] },
    { position: [.54, 5.78, -.28], scale: [.22, 1.53, 1.54] },
    { position: [-1.03, 6.46, -.28], scale: [3.51, .22, 1.72] },
  ]), 'loft', '二层框架', 10);
  structure(batchBoxes(colors.white, [
    { position: [-1.7, 5.86, -.72], scale: [.09, .94, .09] },
    { position: [-.38, 5.86, -.72], scale: [.09, .94, .09] },
  ]), 'loft', '二层窗框', 8);
  const roofLeft = wall('loft', '左斜屋顶', 8, 1.97, .2, 2.12, colors.red, -1.93, 6.72, -.32, .065); roofLeft.rotation.z = .19;
  const roofRight = wall('loft', '右斜屋顶', 8, 1.97, .2, 2.12, colors.red, -.13, 6.72, -.32, .065); roofRight.rotation.z = -.19;
  structure(pipe([-2.38, 6.45, -.2], [-2.38, 8.06, -.2], .11, colors.white), 'marquee', '招牌左支柱', 10);
  structure(pipe([.32, 6.45, -.2], [.32, 8.06, -.2], .11, colors.white), 'marquee', '招牌右支柱', 10);
  wall('marquee', '楼顶招牌边框', 8, 3.55, 1.25, .31, colors.white, -1.03, 7.67, -.14, .11);
  structure(prop(sign('KFB', 3.33, 1.02, -1.03, 7.67, .08)), 'marquee', '楼顶招牌', 8);
  wall('marquee', '招牌金边', 8, 3.58, .1, .39, colors.yellow, -1.03, 8.35, -.12, .035);
  structure(batchBoxes('#ffdf72', [
    { position: [-2.49, 7.11, .1], scale: [.12, .12, .1] },
    { position: [-1.76, 7.11, .1], scale: [.12, .12, .1] },
    { position: [-1.03, 7.11, .1], scale: [.12, .12, .1] },
    { position: [-.3, 7.11, .1], scale: [.12, .12, .1] },
    { position: [.43, 7.11, .1], scale: [.12, .12, .1] },
  ]), 'marquee', '招牌灯泡', 8);

  // LEFT: a grounded hollow chicken bucket, with its front lip as the weak spot.
  const bucketProfile = [new THREE.Vector2(.87, .3), new THREE.Vector2(1.34, 2.6), new THREE.Vector2(1.3, 2.7), new THREE.Vector2(1.21, 2.7), new THREE.Vector2(.78, .36)];
  const shell = new THREE.Mesh(geometry('large-chicken-bucket', () => new THREE.LatheGeometry(bucketProfile, 40)), material(colors.red));
  shell.position.set(-4.55, 0, -.12); prop(shell, 'bucket');
  const bucketRim = ring(1.27, .075, colors.white, -4.55, 2.69, -.12, 'bucket'); bucketRim.rotation.x = Math.PI / 2;
  const bucketBottom = ring(.89, .055, colors.white, -4.55, .35, -.12, 'bucket'); bucketBottom.rotation.x = Math.PI / 2;
  cylinder(.8, .8, .09, colors.darkRed, -4.55, .42, -.12, 'bucket');
  const bucketStripes = [-.75, .75].map(offset => ({ position: [-4.55 + offset, 1.38, .86], scale: [.3, 1.7, .04], rotation: [0, 0, -offset * .15] }));
  batchBoxes(colors.white, bucketStripes, 'bucket');
  prop(sign('KFB', 1.28, .55, -4.55, 1.56, 1.04), 'bucket');
  const bucketFoods = [
    food('nugget', -4.52, 2.92, 1.28, 1.16, -.12, { setpiece: 'bucket' }),
    food('nugget', -5.43, 2.88, .35, 1.15, -.32, { setpiece: 'bucket' }),
    food('nugget', -4.6, 3.18, -.1, 1.28, .18, { setpiece: 'bucket' }),
    food('nugget', -3.64, 2.9, .35, 1.12, .32, { setpiece: 'bucket' }),
    food('nugget', -5.55, .58, 1.2, .95, -.24, { setpiece: 'bucket' }),
    food('nugget', -4.53, .55, 1.55, 1.1, .13, { setpiece: 'bucket' }),
    food('nugget', -3.5, .59, 1.44, .9, .32, { setpiece: 'bucket' }),
  ];
  const bucketTriggerRing = ring(.4, .055, colors.yellow, -4.52, 2.92, 1.12, 'bucket');
  chain('bucket', '鸡块桶倾倒', bucketFoods, bucketFoods[0], [-4.55, 2.7, .6], bucketTriggerRing);

  // RIGHT: the fries form six working fan blades, anchored to a carton tower.
  block(2.3, .18, 1.8, colors.darkRed, 4.55, .4, .25, .07, 'fries');
  const carton = cylinder(1.28, .91, 1.35, colors.red, 4.55, 1.14, .22, 'fries'); carton.scale.z = .56;
  block(2.35, .12, 1.34, colors.yellow, 4.55, 1.84, .22, .035, 'fries');
  prop(sign('KFB', 1.3, .45, 4.55, 1.12, 1.01), 'fries');
  pipe([4.55, 1.85, .2], [4.55, 3.88, .2], .13, colors.steel, 'fries');
  pipe([3.78, .55, .25], [4.55, 2.65, .2], .08, colors.yellow, 'fries');
  pipe([5.32, .55, .25], [4.55, 2.65, .2], .08, colors.yellow, 'fries');
  const hub = cylinder(.42, .42, .28, colors.red, 4.55, 3.8, .62, 'fries'); hub.rotation.x = Math.PI / 2;
  const fanRing = ring(.55, .065, colors.yellow, 4.55, 3.8, 1.44, 'fries');
  const fanFoods = [];
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3 + .14;
    fanFoods.push(food('fry', 4.55 + Math.cos(angle) * .9, 3.8 + Math.sin(angle) * .9, .84, 1.78, angle - Math.PI / 2, { setpiece: 'fries' }));
  }
  const fanTrigger = food('fry', 4.55, 3.8, 1.53, 1.04, Math.PI / 2, { setpiece: 'fries' }); fanFoods.push(fanTrigger);
  chain('fries', '薯条风扇失控', fanFoods, fanTrigger, [4.55, 3.8, 1], fanRing);

  // CENTER: an oversized roof pump feeds a front valve and the serving counter.
  block(1.65, .17, 1.42, colors.ink, 1.45, 4.64, -.28, .04, 'sauce');
  cylinder(.5, .62, 1.45, colors.red, 1.45, 5.42, -.28, 'sauce');
  cylinder(.37, .5, .2, colors.white, 1.45, 6.22, -.28, 'sauce');
  pipe([1.45, 6.3, -.28], [1.45, 6.61, -.28], .085, colors.steel, 'sauce');
  block(1.27, .14, .28, colors.red, 1.73, 6.67, -.28, .065, 'sauce');
  pipe([1.45, 5.04, -.1], [1.45, 5.04, 1.28], .11, colors.yellow, 'sauce');
  pipe([1.45, 5.04, 1.28], [1.45, 3.03, 1.28], .11, colors.yellow, 'sauce');
  pipe([1.45, 3.03, 1.28], [1.95, 3.03, 1.28], .11, colors.yellow, 'sauce');
  const valve = cylinder(.39, .39, .18, colors.ink, 1.45, 4.61, 1.32, 'sauce'); valve.rotation.x = Math.PI / 2;
  const valveRing = ring(.43, .065, colors.yellow, 1.45, 4.61, 1.44, 'sauce');
  const sauceFoods = [
    food('ketchup', 1.45, 4.61, 1.66, .76, 0, { setpiece: 'sauce' }),
    food('ketchup', 1.96, 2.68, 1.47, .65, -.08, { setpiece: 'sauce' }),
    food('ketchup', .78, 2.67, 1.29, .66, .12, { setpiece: 'sauce' }),
    food('bun', 1.55, 2.49, .91, 1.24, -.12, { setpiece: 'sauce', flat: true }),
    food('bun', 2.34, .93, 1.12, 1.18, .1, { setpiece: 'sauce', flat: true }),
    food('sausage', 1.75, .94, 1.48, 1.1, -.17, { setpiece: 'sauce' }),
    food('ketchup', .95, 1.03, 1.48, .67, .1, { setpiece: 'sauce' }),
  ];
  chain('sauce', '酱料泵喷发', sauceFoods, sauceFoods[0], [1.45, 4.61, 1.5], valveRing);

  // An onion arch belongs to a real shop window, with visible side supports.
  const archX = -1.83, archY = 2.27;
  structure(ring(.98, .105, colors.white, archX, archY, .22, null, Math.PI), 'facade', '拱形窗框', 8);
  wall('facade', '拱窗左柱', 8, .2, 1.4, .3, colors.white, archX - .98, 1.57, .22);
  wall('facade', '拱窗右柱', 8, .2, 1.4, .3, colors.white, archX + .98, 1.57, .22);
  for (let i = 0; i < 5; i++) {
    const angle = i * Math.PI / 4;
    food('onion', archX + Math.cos(angle) * .98, archY + Math.sin(angle) * .98, .47, .63, (i - 2) * .05);
  }
  food('sausage', -2.81, 1.61, .48, 1.14, Math.PI / 2);
  food('sausage', -.85, 1.61, .48, 1.14, Math.PI / 2);
  food('nugget', -2.83, .91, 1.15, .82, -.16);

  // A nine-layer burger is the projecting service-counter pillar.
  const layers = [
    ['bun', .94, 1.5, -.06], ['patty', 1.22, 1.32, .06], ['onion', 1.4, 1.3, -.03],
    ['bun', 1.62, 1.42, .06], ['patty', 1.9, 1.27, -.08], ['onion', 2.08, 1.27, .04],
    ['bun', 2.29, 1.4, -.04], ['patty', 2.56, 1.24, .09], ['bun', 2.86, 1.44, -.05],
  ];
  for (const [kind, y, size, tilt] of layers) food(kind, -.3 + Math.sin(y * 4) * .1, y, 1.46, size, tilt, { flat: true });

  // A pitched edible roof connects to the fascia; custard tarts finish the eaves.
  const roof = [
    [-3.03, 4.77, 1.34, .11], [-2.04, 5.05, 1.42, .17], [-1.03, 5.27, 1.44, .1],
    [-.02, 5.29, 1.41, -.08], [.72, 5.03, 1.2, -.2], [2.34, 4.86, 1.23, -.16],
  ];
  const roofDeck = wall('facade', '食材屋檐', 8, 4.0, .18, 2.35, '#b77b30', -1.29, 4.69, -.1, .04); roofDeck.rotation.z = .1;
  for (const [x, y, size, tilt] of roof) food('bun', x, y, .55, size, tilt, { flat: true });
  foodProp('tart', -3.05, 4.62, -.35, 1.05, -.1);
  foodProp('tart', -1.35, 4.98, -.75, 1.1, .08);
  foodProp('tart', 2.46, 4.66, -.4, .95, -.14);

  // A few grounded spill pieces lead the eye between the three mechanisms.
  food('nugget', -2.09, .57, 1.82, .79, .23);
  food('nugget', -1.23, .56, 1.76, .72, -.3);
  food('fry', 2.78, .48, 1.69, 1.07, Math.PI / 2 + .12);
  food('bun', 3.17, .65, .78, .95, -.12, { flat: true });

  return { decor, setpieces, structureParts };
}
