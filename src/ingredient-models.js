import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createFood } from './food-models.js';

const TAU=Math.PI*2;
const materials=new Map(),geometryCache=new Map();
const sphere=new THREE.SphereGeometry(1,22,14);
const seedGeometry=new THREE.SphereGeometry(1,6,4);
const cube=new THREE.BoxGeometry(1,1,1);
function material(color,roughness=.68,gloss=false){
  const key=`${color}:${roughness}:${gloss}`;
  if(!materials.has(key))materials.set(key,gloss?new THREE.MeshPhysicalMaterial({color,roughness,clearcoat:1,clearcoatRoughness:.12}):new THREE.MeshStandardMaterial({color,roughness}));
  return materials.get(key);
}
function cached(key,make){if(!geometryCache.has(key))geometryCache.set(key,make());return geometryCache.get(key);}
function add(group,geometry,color,position=[0,0,0],scale=[1,1,1],roughness=.68,gloss=false){
  const m=new THREE.Mesh(geometry,material(color,roughness,gloss));m.position.set(...position);m.scale.set(...scale);m.castShadow=true;m.receiveShadow=true;group.add(m);return m;
}
function instances(group,geometry,color,transforms,roughness=.68){
  const mesh=new THREE.InstancedMesh(geometry,material(color,roughness),transforms.length),dummy=new THREE.Object3D();
  transforms.forEach((t,i)=>{dummy.position.set(...t.position);dummy.scale.set(...t.scale);dummy.rotation.set(...(t.rotation||[0,0,0]));dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);});
  mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);return mesh;
}
function randomizer(seed){return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};}
function finish(group,kind){
  group.updateMatrixWorld(true);const center=new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3());
  group.children.forEach(child=>child.position.sub(center));group.updateMatrixWorld(true);
  const size=new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  group.userData.dimensions={x:size.x,y:size.y,z:size.z};group.userData.ingredientKind=kind;
  return group;
}

function bun(group){
  add(group,cached('bun-flat',()=>new THREE.CylinderGeometry(.65,.65,.095,36)),'#f7cf8b',[0,-.12,0]);
  add(group,cached('bun-dome',()=>new THREE.SphereGeometry(1,28,16,0,TAU,0,Math.PI/2)),'#e8aa50',[0,-.07,0],[.66,.43,.66],.55);
  const seeds=[],random=randomizer(63);
  for(let i=0;i<37;i++){
    const angle=random()*TAU,r=Math.sqrt(random())*.58,y=-.07+Math.sqrt(1-(r/.66)**2)*.43;
    seeds.push({position:[Math.cos(angle)*r,y+.013,Math.sin(angle)*r],scale:[.018,.009,.043],rotation:[0,random()*TAU,0]});
  }
  instances(group,seedGeometry,'#fff0bb',seeds,.8);
}
function ketchup(group){
  const drop=cached('ketchup-drop',()=>new THREE.LatheGeometry([
    new THREE.Vector2(0,-.34),new THREE.Vector2(.2,-.33),new THREE.Vector2(.4,-.23),new THREE.Vector2(.45,-.06),
    new THREE.Vector2(.4,.12),new THREE.Vector2(.27,.3),new THREE.Vector2(.12,.48),new THREE.Vector2(.025,.64),new THREE.Vector2(0,.7),
  ],28));
  add(group,drop,'#df3027',[0,0,0],[1,1,1],.2,true);
  add(group,sphere,'#f34731',[-.1,-.25,.08],[.35,.12,.33],.17,true);
}
function patty(group){
  const geo=cached('patty',()=>{
    const g=new THREE.CylinderGeometry(.65,.66,.22,40,2),p=g.attributes.position;
    for(let i=0;i<p.count;i++){
      const x=p.getX(i),z=p.getZ(i),angle=Math.atan2(z,x),r=1+.025*Math.sin(angle*13)+.015*Math.sin(angle*21);
      p.setXYZ(i,x*r,p.getY(i),z*r);
    }g.computeVertexNormals();return g;
  });
  add(group,geo,'#704129',[0,0,0],[1,1,1],.82);
  const marks=[],texture=[],random=randomizer(15);
  for(let i=0;i<6;i++){
    const z=(i-2.5)*.19,length=2*Math.sqrt(.59**2-z*z);
    marks.push({position:[0,.114,z],scale:[length,.012,.044],rotation:[0,.17,0]});
  }
  instances(group,cube,'#3f2921',marks,.9);
  for(let i=0;i<56;i++){
    const a=random()*TAU,r=Math.sqrt(random())*.61,s=.012+random()*.018;
    texture.push({position:[Math.cos(a)*r,.112,Math.sin(a)*r],scale:[s,.009,s*.8]});
  }
  instances(group,seedGeometry,'#a8693b',texture,.87);
}
function onion(group){
  const shape=new THREE.Shape();shape.absarc(0,0,.61,0,TAU,false);
  const hole=new THREE.Path();hole.absarc(0,0,.40,0,TAU,true);shape.holes.push(hole);
  const geometry=cached('onion-ring',()=>{const g=new THREE.ExtrudeGeometry(shape,{depth:.14,steps:1,bevelEnabled:true,bevelThickness:.014,bevelSize:.015,bevelSegments:2,curveSegments:32});g.translate(0,0,-.07);g.rotateX(Math.PI/2);return g;});
  add(group,geometry,'#f5d7ef',[0,0,0],[1,1,1],.35);
  const outer=add(group,cached('onion-skin',()=>new THREE.TorusGeometry(.594,.023,6,40)),'#9e49a7',[0,.086,0],undefined,.39);outer.rotation.x=Math.PI/2;
  const inner=add(group,cached('onion-inner',()=>new THREE.TorusGeometry(.475,.014,6,40)),'#c68abe',[0,.086,0],undefined,.42);inner.rotation.x=Math.PI/2;
  const back=outer.clone();back.position.y=-.086;group.add(back);
}
function sausage(group){
  const body=add(group,cached('sausage',()=>new THREE.CapsuleGeometry(.22,1.0,6,20)),'#b85430',[0,0,0],undefined,.38,true);body.rotation.z=Math.PI/2;
  const cuts=[];
  for(let i=0;i<4;i++)cuts.push({position:[(i-1.5)*.25,.225,.016],scale:[.033,.012,.19],rotation:[0,.4,0]});
  instances(group,cube,'#773622',cuts,.62);
  const end=add(group,sphere,'#ce7141',[-.66,0,0],[.04,.12,.12],.42);end.rotation.z=-.2;
}

/** Reusable toy food geometry, centered and measured in local game units. */
export function createIngredient(kind){
  if(kind==='fry'||kind==='nugget'||kind==='burgerbomb'){
    const result=createFood(kind==='burgerbomb'?'bigmac':kind);result.name=`ingredient-${kind}`;result.userData.ingredientKind=kind;return result;
  }
  const group=new THREE.Group();group.name=`ingredient-${kind}`;
  switch(kind){
    case 'bun':bun(group);break;
    case 'ketchup':ketchup(group);break;
    case 'patty':patty(group);break;
    case 'onion':onion(group);break;
    case 'sausage':sausage(group);break;
    default:throw new Error(`Unknown ingredient kind: ${kind}`);
  }
  return finish(group,kind);
}

/** Camera-held paper-carton launcher. Its broad round mouth points along -Z. */
export function createFoodLauncher(){
  const group=new THREE.Group();group.name='food-launcher';
  add(group,cached('launcher-shell',()=>new RoundedBoxGeometry(1.03,.8,1.18,2,.11)),'#df4433',[0,0,.04],undefined,.57);
  add(group,cached('launcher-lid',()=>new RoundedBoxGeometry(1.1,.1,1.23,2,.035)),'#fff1ca',[0,.43,.04]);
  const feedPort=add(group,cached('launcher-feed-port',()=>new THREE.CircleGeometry(.325,24)),'#53372c',[0,.484,-.03]);feedPort.rotation.x=-Math.PI/2;
  const feedRim=add(group,cached('launcher-feed-rim',()=>new THREE.TorusGeometry(.34,.045,8,28)),'#ffbf3d',[0,.493,-.03],undefined,.4);feedRim.rotation.x=Math.PI/2;
  const chamberAnchor=new THREE.Object3D();chamberAnchor.name='launcher-chamber';chamberAnchor.position.set(0,.91,-.03);group.add(chamberAnchor);
  const nozzle=add(group,cached('launcher-nozzle',()=>new THREE.CylinderGeometry(.32,.39,.8,28,1,true)),'#f4b83e',[0,.17,-.7],undefined,.42);nozzle.rotation.x=-Math.PI/2;
  const rim=add(group,cached('launcher-rim',()=>new THREE.TorusGeometry(.315,.055,8,28)),'#fff0b8',[0,.17,-1.105],undefined,.43);
  const inside=add(group,cached('launcher-inner',()=>new THREE.CircleGeometry(.27,28)),'#53372c',[0,.17,-.94]);inside.rotation.y=Math.PI;
  add(group,cached('launcher-grip',()=>new RoundedBoxGeometry(.48,.65,.53,2,.1)),'#bd3e31',[0,-.65,.23]);
  add(group,cached('launcher-grip-bottom',()=>new RoundedBoxGeometry(.6,.12,.61,2,.035)),'#ffd565',[0,-1.0,.23]);
  const stripes=[];
  for(const side of [-1,1])for(let i=0;i<3;i++)stripes.push({position:[side*.518,.02,(i-1)*.27],scale:[.012,.57,.055],rotation:[0,0,side*.2]});
  instances(group,cube,'#ffedc9',stripes);
  // The rear receiver faces the player so loaded food and its count stay on the gun.
  const receiver=new THREE.Group();receiver.name='launcher-receiver';receiver.position.set(0,.09,.684);receiver.rotation.x=-.16;group.add(receiver);
  add(receiver,cached('launcher-display-frame',()=>new RoundedBoxGeometry(.97,.52,.105,2,.05)),'#fff1ce',[0,0,0],undefined,.47);
  add(receiver,cached('launcher-display-bezel',()=>new RoundedBoxGeometry(.87,.41,.035,2,.026)),'#342a27',[0,0,.058],undefined,.48);
  const display=new THREE.Mesh(cached('launcher-display-plane',()=>new THREE.PlaneGeometry(.81,.35)),new THREE.MeshBasicMaterial({color:'#ffffff',toneMapped:false}));
  display.name='launcher-display';display.position.set(0,0,.078);display.userData.displaySize={width:.81,height:.35};receiver.add(display);
  const displayAnchor=new THREE.Object3D();displayAnchor.name='launcher-display-anchor';displayAnchor.position.set(0,.29,.078);receiver.add(displayAnchor);
  const statusLight=add(receiver,sphere,'#a9e968',[-.403,.205,.055],[.023,.023,.012],.28,true);statusLight.castShadow=false;
  for(const x of [-.427,.427])add(receiver,cached('launcher-screen-fastener',()=>new THREE.CylinderGeometry(.018,.018,.018,8)),'#eab742',[x,-.203,.058],[1,1,1],.4).rotation.x=Math.PI/2;
  const lever=add(group,cached('launcher-lever',()=>new THREE.CylinderGeometry(.075,.075,.34,12)),'#ffe2a0',[.61,.08,.29]);lever.rotation.z=Math.PI/2;
  add(group,sphere,'#f5bd46',[.8,.08,.29],[.14,.14,.14],.4);
  const muzzle=new THREE.Object3D();muzzle.name='launcher-muzzle';muzzle.position.set(0,.17,-1.18);group.add(muzzle);
  finish(group,'launcher');group.userData.muzzle=muzzle.position.toArray();group.userData.forward=[0,0,-1];
  return group;
}
