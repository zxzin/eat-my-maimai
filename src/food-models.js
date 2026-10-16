import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// The foods are deliberately oversized toy props. Their physics values belong
// to the game and do not describe real nutrition or product performance.
const TAU = Math.PI * 2;
const materials = new Map();
const textures = new Map();
const foodMaterials = new Map();
const sphere = new THREE.SphereGeometry(1, 24, 16);
const grainGeometry = new THREE.SphereGeometry(1, 7, 5);
const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
const nuggetGeometry = (() => {
  const g = new THREE.SphereGeometry(1, 20, 14);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ripple = 1 + 0.045 * Math.sin(x * 12 + z * 7) * Math.cos(y * 15 - z * 9);
    p.setXYZ(i, x * ripple, y * ripple, z * ripple);
  }
  g.computeVertexNormals();
  return g;
})();

function mat(color, roughness = 0.72) {
  const key = `${color}:${roughness}`;
  if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color, roughness }));
  return materials.get(key);
}
function toasted(kind = 'bun') {
  if (foodMaterials.has(kind)) return foodMaterials.get(kind);
  const base = kind === 'chicken' ? '#db7814' : '#e59619';
  let map = null;
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d'), random = seeded(kind === 'chicken' ? 62 : 12);
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, kind === 'chicken' ? '#ef9d20' : '#b85b0c');
    gradient.addColorStop(.38, kind === 'chicken' ? '#c4650c' : '#e29413');
    gradient.addColorStop(.76, kind === 'chicken' ? '#e59316' : '#f9bd39');
    gradient.addColorStop(1, kind === 'chicken' ? '#f3b22d' : '#ffdb7b');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1000; i++) {
      ctx.fillStyle = i % 3 ? 'rgba(100,39,7,.23)' : 'rgba(255,225,124,.32)';
      const radius = kind === 'chicken' ? 1.5 + random() * 4 : .4 + random() * 1.4;
      ctx.beginPath(); ctx.ellipse(random() * 256, random() * 256, radius, radius * .6, 0, 0, TAU); ctx.fill();
    }
    map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  }
  const material = new THREE.MeshStandardMaterial({color: map ? '#ffffff' : base, map, roughness:kind === 'bun' ? .46 : .74});
  foodMaterials.set(kind, material); return material;
}
function mesh(geometry, material, position = [0, 0, 0], scale = [1, 1, 1]) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(...position);
  m.scale.set(...scale);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function ball(group, color, position, scale, roughness) {
  const m = mesh(sphere, mat(color, roughness), position, scale);
  group.add(m); return m;
}
function cylinder(group, top, bottom, height, color, y = 0, segments = 40) {
  const m = mesh(new THREE.CylinderGeometry(top, bottom, height, segments), mat(color), [0, y, 0]);
  group.add(m); return m;
}
function seeded(seed = 1) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}
function instances(group, geometry, material, transforms) {
  const m = new THREE.InstancedMesh(geometry, material, transforms.length);
  const dummy = new THREE.Object3D();
  transforms.forEach((t, i) => {
    dummy.position.set(...t.position);
    dummy.scale.set(...t.scale);
    dummy.rotation.set(...(t.rotation || [0, 0, 0]));
    dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix);
  });
  m.castShadow = true; m.receiveShadow = true; group.add(m); return m;
}
function labelTexture(text, background = '#e52629', foreground = '#fff8e9', sub = '', stripes = false) {
  const key = `${text}/${background}/${foreground}/${sub}/${stripes}`;
  if (textures.has(key)) return textures.get(key);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background; ctx.fillRect(0, 0, 1024, 512);
  if (stripes) {
    ctx.fillStyle = '#fff7e8';
    for (let x = -150; x < 1200; x += 270) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 85, 0);
      ctx.lineTo(x + 215, 512); ctx.lineTo(x + 130, 512); ctx.fill();
    }
    ctx.fillStyle = background; ctx.fillRect(290, 60, 444, 392);
  }
  ctx.fillStyle = foreground; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `900 ${text.length > 7 ? 100 : 190}px Arial, sans-serif`;
  ctx.fillText(text, 512, sub ? 225 : 256, 890);
  if (sub) { ctx.font = '700 34px Arial, sans-serif'; ctx.fillText(sub, 512, 368, 850); }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4; textures.set(key, texture); return texture;
}
function labelMaterial(text, background, foreground, sub, stripes) {
  const map = labelTexture(text, background, foreground, sub, stripes);
  const key = `label:${text}/${background}/${foreground}/${sub}/${stripes}`;
  if (!foodMaterials.has(key)) foodMaterials.set(key, new THREE.MeshStandardMaterial({ color: map ? '#ffffff' : background, map, roughness: 0.55 }));
  return foodMaterials.get(key);
}
function sesame(group, y, radius, domeHeight, seed = 9, count = 43) {
  const random = seeded(seed), transforms = [];
  for (let i = 0; i < count; i++) {
    const a = random() * TAU, r = Math.sqrt(random()) * radius * 0.88;
    const ny = Math.sqrt(1 - (r / radius) ** 2);
    transforms.push({ position: [Math.cos(a) * r, y + ny * domeHeight + 0.014, Math.sin(a) * r],
      scale: [0.018, 0.011, 0.048], rotation: [Math.cos(a) * 0.25, random() * TAU, Math.sin(a) * 0.25] });
  }
  instances(group, grainGeometry, mat('#fff0bc'), transforms);
}
function lettuce(group, y, radius = 0.76) {
  const verts = [], indices = [], count = 64;
  for (let ring = 0; ring < 3; ring++) {
    for (let i = 0; i <= count; i++) {
      const a = i / count * TAU;
      const r = radius * [0.35, 0.82, 1][ring] * (1 + 0.075 * Math.sin(a * 9));
      verts.push(Math.cos(a) * r, y + (ring / 2) * 0.05 * Math.sin(a * 12), Math.sin(a) * r);
    }
  }
  for (let r = 0; r < 2; r++) for (let i = 0; i < count; i++) {
    const a = r * (count + 1) + i, b = a + count + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(indices); geo.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: '#4e9d18', roughness: 0.8, side: THREE.DoubleSide });
  group.add(mesh(geo, material));
}
function cheese(group, y, rotation = 0.22) {
  const geo = new THREE.PlaneGeometry(1.28, 1.28, 4, 4); geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), overhang = Math.max(0, Math.hypot(x, z) - .57);
    p.setY(i, -.56 * overhang + Math.sin(x * 7 + z * 4) * .009);
  }
  geo.computeVertexNormals();
  const material = mat('#ffb309', .28); material.side = THREE.DoubleSide;
  const m = mesh(geo, material, [0,y,0]); m.rotation.y = rotation; group.add(m);
}
function crumbs(group, center, radii, seed = 2, count = 58, kind = 'chicken') {
  const random = seeded(seed), transforms = [];
  for (let i = 0; i < count; i++) {
    const a = random() * TAU, v = random() * 2 - 1, q = Math.sqrt(1 - v * v);
    const size = 0.024 + random() * 0.028;
    transforms.push({position: [center[0] + q * Math.cos(a) * radii[0], center[1] + v * radii[1], center[2] + q * Math.sin(a) * radii[2]],
      scale: [size, size * 0.8, size], rotation: [random() * 3, random() * 3, 0]});
  }
  instances(group, grainGeometry, mat(kind==='beef'?'#8b4725':'#f4a51d',.75), transforms.filter((_,i)=>i%3));
  instances(group, grainGeometry, mat(kind==='beef'?'#30180f':'#a74d0b',.83), transforms.filter((_,i)=>!(i%3)));
}
function burger(group, big = false, chicken = false, character = false) {
  group.add(mesh(sphere, toasted(), [0,-.34,0], [.73,.17,.73]));
  cylinder(group, 0.72, 0.72, 0.065, '#efaf31', -0.25);
  lettuce(group, -0.17);
  const pattyY = big ? [-0.07, 0.22] : [-0.015];
  pattyY.forEach((y, i) => {
    if (chicken) { group.add(mesh(nuggetGeometry, toasted('chicken'), [0, y, 0], [0.72, 0.16, 0.68])); crumbs(group, [0,y,0], [0.71,0.15,0.67], 12, 42); }
    else {
      cylinder(group, 0.67, 0.66, 0.17, '#492519', y);
      crumbs(group, [0,y,0], [0.65,0.07,0.65], i+11, 27, 'beef');
    }
    if (!chicken) cheese(group, y + 0.095, i * 0.6 + 0.25);
  });
  if (big) {
    cylinder(group, 0.68, 0.7, 0.13, '#db8c1e', 0.085);
    lettuce(group, 0.17, 0.72);
  }
  if (chicken) cylinder(group, 0.65, 0.65, 0.045, '#f4ead4', 0.12);
  // Soft glossy sauce and pickle edges remain visible when the burger is small.
  const sauce = [], pickles = [];
  for (let i=0;i<7;i++) {
    const a=i/7*TAU, r=.63;
    sauce.push({position:[Math.cos(a)*r,big?.31:.105,Math.sin(a)*r],scale:[.095,.032,.09]});
    if (big && i%2===0) pickles.push({position:[Math.cos(a)*.61,.325,Math.sin(a)*.61],scale:[.19,.034,.13],rotation:[0,a,0]});
  }
  instances(group,sphere,mat(chicken?'#fff8e3':'#ec8e2a',.2),sauce);
  if (pickles.length) instances(group,sphere,mat('#4a8d21',.34),pickles);
  const topY = big ? 0.39 : 0.16;
  cylinder(group, 0.73, 0.75, 0.065, '#bd6a16', topY);
  const dome = mesh(new THREE.SphereGeometry(1, 32, 16, 0, TAU, 0, Math.PI / 2), toasted(), [0, topY + 0.025, 0], [0.75, 0.36, 0.75]);
  group.add(dome); sesame(group, topY + 0.025, 0.75, 0.36, big ? 12 : 5);
  if (character) angryFace(group,topY);
}
function angryFace(group,topY) {
  instances(group,sphere,mat('#ffffff',.22),[-1,1].map(side=>({position:[side*.21,topY+.145,.675],scale:[.108,.113,.045]})));
  instances(group,sphere,mat('#1d1612',.22),[-1,1].map(side=>({position:[side*.185,topY+.135,.719],scale:[.045,.06,.018]})));
  instances(group,cubeGeometry,mat('#392013'),[-1,1].map(side=>({position:[side*.215,topY+.25,.672],scale:[.255,.055,.055],rotation:[0,0,side*.3]})));
}
function fishBurger(group) {
  group.add(mesh(sphere,toasted(),[0,-.31,0],[.72,.16,.72]));
  cylinder(group,.7,.72,.065,'#efb638',-.225);
  cheese(group,-.16,.1);
  group.add(mesh(new RoundedBoxGeometry(1.25,.25,1.15,2,.065),toasted('chicken'),[0,-.025,0]));
  const random=seeded(51),crunch=[];
  for(let i=0;i<45;i++) {
    const face=i%3,x=(random()-.5)*1.19,y=(random()-.5)*.2,z=(random()-.5)*1.08,s=.023+random()*.022;
    crunch.push({position:face===0?[x,.11,z]:face===1?[x,y,(i%2?1:-1)*.578]:[(i%2?1:-1)*.626,y,z],scale:[s,s*.7,s]});
  }
  instances(group,grainGeometry,mat('#efa11e'),crunch);
  const sauce=[];
  for(let i=0;i<8;i++){const a=i/8*TAU;sauce.push({position:[Math.cos(a)*.52,.15,Math.sin(a)*.52],scale:[.13,.035,.1]});}
  instances(group,sphere,mat('#fff4d5',.28),sauce);
  cylinder(group,.72,.73,.06,'#dc911e',.19);
  group.add(mesh(new THREE.SphereGeometry(1,32,16,0,TAU,0,Math.PI/2),toasted(),[0,.215,0],[.74,.33,.74]));
  angryFace(group,.19);
}
function nugget(group, pos, scale, seed) {
  const n = mesh(nuggetGeometry, toasted('chicken'), pos, scale); n.rotation.y = seed * 0.42; group.add(n);
  crumbs(group, pos, scale.map(v=>v*0.98), seed, 34);
}
function nuggets(group, count=5) {
  nugget(group, [-0.33,-0.02,0.22], [0.45,0.2,0.36], 4);
  nugget(group, [0.34,-0.02,0.18], [0.43,0.21,0.34], 10);
  nugget(group, [-0.33,0.17,-0.23], [0.43,0.21,0.34], 17);
  nugget(group, [0.35,0.17,-0.25], [0.42,0.2,0.33], 21);
  if(count>4)nugget(group, [0,0.37,0.02], [0.43,0.2,0.33], 26);
}
function chicken(group) {
  group.add(mesh(nuggetGeometry, toasted('chicken'), [-0.16,0.03,0], [0.63,0.43,0.45]));
  crumbs(group, [-0.16,0.03,0], [0.62,0.43,0.45], 16, 94);
  const bone = mesh(new THREE.CylinderGeometry(0.09,0.11,0.62,12), mat('#fffaf0'), [0.63,0.035,0]); bone.rotation.z = Math.PI / 2; group.add(bone);
  ball(group, '#fffaf0', [0.95,0.1,0.055], [0.13,0.13,0.14]);
  ball(group, '#fffaf0', [0.95,-0.03,-0.055], [0.13,0.13,0.14]);
}
function fries(group, small=false) {
  const random = seeded(16), transforms = [];
  for (let i = 0; i < (small?11:19); i++) {
    const x = (random()-0.5)*(small?.72:.95), z = (random()-0.5)*(small?.37:.5), h = (small?.52:.64) + random()*(small?.42:.57);
    transforms.push({position:[x,(small?.18:.26)+h/2,z],scale:[0.12,h,0.12],rotation:[(random()-0.5)*0.2,random()*0.18,(random()-0.5)*0.2]});
  }
  const sticks=instances(group,new THREE.BoxGeometry(1,1,1),mat('#ffffff',0.52),transforms);
  const fryColors=['#ffbc0d','#e99708','#ffd13e'];
  for(let i=0;i<transforms.length;i++)sticks.setColorAt(i,new THREE.Color(fryColors[i%fryColors.length]));
  const cartonColor=small?'#ffffff':'#da291c',markColor=small?'#da291c':'#ffbc0d';
  const box = mesh(new THREE.CylinderGeometry(small?.54:.67,small?.37:.46,small?.68:.85,4,1,false,Math.PI/4),labelMaterial('M',cartonColor,markColor,'FRIES'),[0,-0.07,0],[1,1,small?.65:.59]);
  group.add(box);
  // A front badge keeps the mark upright and readable from the stage camera.
  const badge = mesh(new THREE.PlaneGeometry(small?.48:.6,small?.3:.36),labelMaterial('M',cartonColor,markColor),[0,small?-.015:.02,small?.261:.292]); group.add(badge);
}
function fry(group) {
  const body = mesh(cubeGeometry, mat('#ffbc0d',.46),[0,0,0],[.18,1.12,.18]);
  body.rotation.z=.06;group.add(body);
  const edge = mesh(cubeGeometry,mat('#cf7604',.6),[.085,0,.03],[.035,1.12,.12]);edge.rotation.z=.06;group.add(edge);
  instances(group,grainGeometry,mat('#fff8e8'),[
    {position:[-.055,.27,.095],scale:[.016,.017,.01]},
    {position:[.02,-.13,.095],scale:[.019,.015,.01]},
    {position:[.06,.4,.095],scale:[.013,.014,.01]},
  ]);
}
function cola(group, rival = false) {
  const cup = mesh(new THREE.CylinderGeometry(0.45,0.34,1.25,40), labelMaterial(rival ? 'KFB' : 'M',rival ? '#176bca' : '#e82d2f','#fff9e9','ICE COLD'),[0,-0.03,0]);
  cup.rotation.y = Math.PI; group.add(cup);
  cylinder(group,0.48,0.48,0.07,'#f9f1e2',0.63);
  cylinder(group,0.41,0.46,0.06,'#ffffff',0.68);
  const straw=mesh(new THREE.CylinderGeometry(0.037,0.037,0.72,10),mat('#ef4547'),[0.12,0.99,0]); straw.rotation.z=-0.15; group.add(straw);
  const highlight=mesh(new THREE.CylinderGeometry(.453,.343,1.18,24,1,true,.45,.18),mat('#ffeade',.19),[0,-.03,0]);group.add(highlight);
  const drops=[],random=seeded(14);
  for(let i=0;i<14;i++) {
    const a=random()*TAU,y=random()*.96-.5,r=.385+y*.075;
    drops.push({position:[Math.sin(a)*r,y,Math.cos(a)*r],scale:[.016+random()*.014,.025+random()*.027,.016]});
  }
  instances(group,grainGeometry,mat('#f9fcff',.08),drops);
}
function icecream(group) {
  const cup=mesh(new THREE.CylinderGeometry(0.49,0.34,0.82,36),labelMaterial('McFlurry','#fff8e9','#473126','COOKIE CRUNCH'),[0,-0.15,0]);cup.rotation.y=Math.PI;group.add(cup);
  cylinder(group,0.5,0.49,0.065,'#ffffff',0.275);
  ball(group,'#fff5df',[0,0.28,0],[0.46,0.2,0.46],0.5);
  for(let i=0;i<4;i++) {
    const torus=mesh(new THREE.TorusGeometry(0.33-i*0.073,0.09-i*0.01,8,28),mat('#fff7e5',0.5),[0,0.4+i*0.095,0]); torus.rotation.x=Math.PI/2; group.add(torus);
  }
  ball(group,'#fff7e5',[0.02,0.74,0],[0.065,0.12,0.065],0.5);
  const random=seeded(33), transforms=[];
  for(let i=0;i<24;i++) {const a=random()*TAU,r=Math.sqrt(random())*0.4;transforms.push({position:[Math.cos(a)*r,0.44+0.24*(1-r/0.44),Math.sin(a)*r],scale:[0.04+random()*0.025,0.035,0.04],rotation:[random()*2,random()*3,random()*2]});}
  instances(group,new THREE.BoxGeometry(1,1,1),mat('#43291d'),transforms);
  const spoon=mesh(new THREE.BoxGeometry(0.065,0.62,0.045),mat('#beceec',0.4),[-0.27,0.56,-0.08]); spoon.rotation.z=-0.3;group.add(spoon);
}
function tart(group) {
  const count=96, vertices=[],indices=[];
  const rings=[{r:0.52,y:-0.17},{r:0.7,y:0.08},{r:0.66,y:0.18},{r:0.52,y:0.12}];
  rings.forEach(({r,y},ring)=>{for(let i=0;i<=count;i++){const a=i/count*TAU,wave=ring===0?0.015:0.035;const radius=r+wave*Math.cos(a*24);vertices.push(Math.cos(a)*radius,y,Math.sin(a)*radius);}});
  for(let r=0;r<rings.length-1;r++)for(let i=0;i<count;i++){const a=r*(count+1)+i,b=a+count+1;indices.push(a,a+1,b,a+1,b+1,b);}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geo.setIndex(indices);geo.computeVertexNormals();
  const crustMaterial=new THREE.MeshStandardMaterial({color:'#b96611',roughness:0.74,side:THREE.DoubleSide});group.add(mesh(geo,crustMaterial));
  cylinder(group,0.54,0.51,0.19,'#ffc836',0.02);
  ball(group,'#ffdc65',[0,.11,0],[.51,.035,.51],.24);
  const random=seeded(4),transforms=[];
  for(let i=0;i<13;i++){const a=random()*TAU,r=Math.sqrt(random())*0.4,s=0.04+random()*0.075;transforms.push({position:[Math.cos(a)*r,0.142,Math.sin(a)*r],scale:[s,0.009,s*0.75],rotation:[0,random()*TAU,0]});}
  instances(group,grainGeometry,mat('#874521',0.53),transforms);
}
function bucket(group) {
  // A real hollow rim makes chicken pieces visible from the elevated camera.
  const profile=[new THREE.Vector2(0.53,-0.65),new THREE.Vector2(0.77,0.55),new THREE.Vector2(0.76,0.61),new THREE.Vector2(0.70,0.61),new THREE.Vector2(0.49,-0.56)];
  const shell=mesh(new THREE.LatheGeometry(profile,48),mat('#fff0d6'));group.add(shell);
  const sleeve=mesh(new THREE.CylinderGeometry(0.774,0.534,1.2,48,1,true),labelMaterial('KFB','#d91e29','#fff8e8','CHICKEN',true),[0,-0.05,0]);sleeve.rotation.y=Math.PI;group.add(sleeve);
  const sideBadge=mesh(new THREE.CylinderGeometry(.752,.636,.58,18,1,true,1.02,1.1),labelMaterial('KFB','#d91e29','#fff8e8'),[0,.12,0]);group.add(sideBadge);
  cylinder(group,0.5,0.5,0.07,'#fff1cf',-0.6);
  const rim=mesh(new THREE.TorusGeometry(0.735,0.045,8,48),mat('#fff3d8'),[0,0.6,0]);rim.rotation.x=Math.PI/2;group.add(rim);
  const random=seeded(3);
  for(let i=0;i<4;i++) {
    const food=new THREE.Group(); chicken(food);food.scale.setScalar(0.47);
    const a=i/4*TAU;food.position.set(Math.cos(a)*0.31,0.54+(i%2)*0.12,Math.sin(a)*0.3);food.rotation.set((random()-0.5)*0.5,a,0.3);group.add(food);
  }
}
function box(group) {
  const materials = [mat('#f4e8d4'),mat('#f4e8d4'),labelMaterial('KFB','#d8202c','#fff8ec','CRISPY CLUB'),mat('#f4e8d4'),labelMaterial('KFB','#d8202c','#fff8ec'),labelMaterial('KFB','#d8202c','#fff8ec')];
  const body=mesh(new THREE.BoxGeometry(1.55,0.55,1.13),materials);group.add(body);
  const lid=mesh(new THREE.BoxGeometry(1.59,0.045,1.17),mat('#fff4df'),[0,0.285,0]);group.add(lid);
  const lidLabel=mesh(new THREE.PlaneGeometry(1.42,0.94),labelMaterial('KFB','#d8202c','#fff8ec','CHICKEN'));lidLabel.rotation.x=-Math.PI/2;lidLabel.position.y=0.311;group.add(lidLabel);
}
function sign(group, text) {
  const badge=mesh(new THREE.CylinderGeometry(0.64,0.64,0.14,48),mat('#f3be4c'));badge.rotation.x=Math.PI/2;group.add(badge);
  const face=mesh(new THREE.CircleGeometry(0.58,48),labelMaterial(text||'KFB','#d91f2c','#fff9ed'));face.position.z=0.074;group.add(face);
  const back=face.clone();back.rotation.y=Math.PI;back.position.z=-0.074;group.add(back);
}

export function createFood(kind, options = {}) {
  const group = new THREE.Group(); group.name = `food-${kind}`;
  switch(kind) {
    case 'burger': burger(group,false,true,true); break;
    case 'bigmac': burger(group,true,false,true); break;
    case 'fishburger': fishBurger(group); break;
    case 'friedBurger': burger(group,false,true); break;
    case 'nugget': nugget(group,[0,0,0],[0.59,0.28,0.47],6); break;
    case 'nuggets': nuggets(group); break;
    case 'nuggets4': nuggets(group,4); break;
    case 'fries': fries(group); break;
    case 'friesSmall': fries(group,true); break;
    case 'fry': fry(group); break;
    case 'cola': cola(group,options.rival); break;
    case 'icecream': icecream(group); break;
    case 'chicken': chicken(group); break;
    case 'tart': tart(group); break;
    case 'bucket': bucket(group); break;
    case 'box': box(group); break;
    case 'sign': sign(group,options.label); break;
    default: burger(group); break;
  }
  group.updateMatrixWorld(true);
  const bounds=new THREE.Box3().setFromObject(group),center=bounds.getCenter(new THREE.Vector3());
  group.children.forEach(child=>child.position.sub(center));
  if (Number.isFinite(options.scale) && options.scale>0) group.scale.setScalar(options.scale);
  group.updateMatrixWorld(true);
  const size=new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  group.userData.dimensions={x:size.x,y:size.y,z:size.z};
  group.userData.foodKind=kind;
  return group;
}
