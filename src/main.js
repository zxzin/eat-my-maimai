import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import './style.css';
import { createFood } from './food-models.js';
import { createIngredient, createFoodLauncher } from './ingredient-models.js';
import { createImpactFX } from './impact-fx.js';
import { INGREDIENTS, PACKS, DEFAULT_PACK_IDS, buildInventory, consumeShot, resolveHit } from './ingredient-rules.js';
import { setupMcpUI } from './mcp-ui.js';
import { createEconomy, payLoadout, earnCoins, purchasePack, canRestock } from './economy.js';

const $=id=>document.getElementById(id),canvas=$('gameCanvas');
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,innerWidth<700?1.5:2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.96;
const scene=new THREE.Scene();scene.background=new THREE.Color('#9fc9cc');scene.fog=new THREE.Fog('#a3c7c4',32,70);
const camera=new THREE.PerspectiveCamera(50,1,.05,100);scene.add(camera);
const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();scene.environment=pmrem.fromScene(room,.08).texture;scene.environmentIntensity=.2;room.dispose();pmrem.dispose();
scene.add(new THREE.HemisphereLight('#ebf7ff','#5a6861',.85));
const sun=new THREE.DirectionalLight('#ffd79c',3.5);sun.position.set(-8,13,10);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-14,right:14,top:14,bottom:-10,far:45});sun.shadow.bias=-.00025;sun.shadow.normalBias=.035;sun.shadow.radius=3;scene.add(sun);
const rim=new THREE.DirectionalLight('#ffbc72',1.3);rim.position.set(8,7,-7);scene.add(rim);
const fill=new THREE.DirectionalLight('#a9cfee',.42);fill.position.set(7,3,8);scene.add(fill);
const flash=new THREE.PointLight('#ffad55',0,12,1.7);scene.add(flash);
const fx=createImpactFX(scene,{reducedMotion:reduced});
const materials=new Map(),geometries=new Map();
function mat(color,roughness=.65){const key=color+roughness;if(!materials.has(key))materials.set(key,new THREE.MeshStandardMaterial({color,roughness}));return materials.get(key);}
function box(w,h,d,color,x,y,z,r=.06){const key=[w,h,d,r].join();if(!geometries.has(key))geometries.set(key,new RoundedBoxGeometry(w,h,d,2,r));const m=new THREE.Mesh(geometries.get(key),mat(color));m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;return m;}
function labelTexture(text,color='#fff5db',bg='#c9272a',w=512,h=160){const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);ctx.fillStyle=color;ctx.font=`900 ${h*.65}px Georgia`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,w/2,h*.54);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;}
function sign(text,w,h,x,y,z){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,.18),new THREE.MeshStandardMaterial({map:labelTexture(text),roughness:.8}));m.position.set(x,y,z);m.castShadow=true;return m;}
const plaza=new THREE.Group();scene.add(plaza);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(120,120),mat('#d4b887',.94));floor.rotation.x=-Math.PI/2;floor.position.y=-.06;floor.receiveShadow=true;plaza.add(floor);
plaza.add(box(15,.2,8,'#eae0c5',0,0,0));
const paving=new THREE.InstancedMesh(new THREE.BoxGeometry(1.45,.035,1.45),mat('#a9bfa7',.95),60),dummy=new THREE.Object3D();let pi=0;
for(let x=-6;x<6;x++)for(let z=0;z<5;z++){dummy.position.set(x*1.5+.75,-.022,4.6+z*1.5);dummy.rotation.set(0,0,0);dummy.updateMatrix();paving.setMatrixAt(pi++,dummy.matrix);}paving.receiveShadow=true;plaza.add(paving);
for(const side of [-1,1]){
  plaza.add(box(2.4,.85,3,'#c16c48',side*8,.4,-1));plaza.add(box(2.3,.2,2.9,'#835b36',side*8,.9,-1));
  for(let j=0;j<5;j++){const leaf=new THREE.Mesh(new THREE.SphereGeometry(.65,14,9),mat(j%2?'#5d8e64':'#426d58'));leaf.scale.set(.5,1.1,.55);leaf.rotation.z=(j-2)*.24;leaf.position.set(side*8+(j-2)*.35,1.25,-.7);leaf.castShadow=true;plaza.add(leaf);}
  const lamp=box(.12,4,.12,'#415a54',side*8.8,2,1.7);plaza.add(lamp);const head=box(.65,.65,.65,'#fff0b4',side*8.8,4.1,1.7,.1);plaza.add(head);
}
for(let i=0;i<9;i++){const m=box(3.5,4+(i%3)*.7,2,'#7caaa3',(i-4)*3.6,1.3,-17,.15);plaza.add(m);plaza.add(box(3.75,.35,2.2,'#638c85',(i-4)*3.6,3.35+(i%3)*.35,-17));}
const castle=new THREE.Group();scene.add(castle);
const launcher=createFoodLauncher();camera.add(launcher);launcher.position.set(.58,-.58,-1.4);launcher.rotation.y=-.08;launcher.scale.setScalar(.28);
let chamber=null,phase='prep',selected='bun',inventory={},selection=[...DEFAULT_PACK_IDS],liveAllowed=null;
let priceSnapshot=null;
let economy=createEconomy(),ownedAmmo=new Set(),restockNotified=false;
const shopModes=new Map(),purchaseReceipts=new Map();
const displayCanvas=document.createElement('canvas');displayCanvas.width=512;displayCanvas.height=256;
const displayContext=displayCanvas.getContext('2d'),displayTexture=new THREE.CanvasTexture(displayCanvas);displayTexture.colorSpace=THREE.SRGBColorSpace;
const gunDisplay=launcher.getObjectByName('launcher-display');gunDisplay.material.map=displayTexture;gunDisplay.material.needsUpdate=true;
let nodes=[],decor=[],projectiles=[],debris=[],removedCount=0,shots=0,comboCount=0,totalNodes=0,goal=0,last=performance.now(),recoil=0,shake=0,hitPause=0,pointer=null,toastTimer,comboTimer,resultTimer,soundEnabled=true,audioContext;
const thumbnails=new Map(),raycaster=new THREE.Raycaster(),aim=new THREE.Vector2(),aimScreen={x:innerWidth/2,y:innerHeight*.45};
const ingredientById=new Map(INGREDIENTS.map(a=>[a.id,a]));
function toast(text){$('toast').textContent=text;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').textContent='',2200);}
function sound(kind='fire'){
 if(!soundEnabled)return;try{audioContext??=new(window.AudioContext||window.webkitAudioContext)();audioContext.resume();const t=audioContext.currentTime,g=audioContext.createGain(),o=audioContext.createOscillator();g.connect(audioContext.destination);g.gain.setValueAtTime(kind==='impact'?.12:.06,t);g.gain.exponentialRampToValueAtTime(.001,t+.22);o.type=kind==='fire'?'sine':'triangle';o.frequency.setValueAtTime(kind==='combo'?560:kind==='fire'?210:110,t);o.frequency.exponentialRampToValueAtTime(kind==='combo'?940:55,t+.2);o.connect(g);o.start(t);o.stop(t+.22);}catch{}
}
function ingredientMesh(id,size=1){const mesh=createIngredient(id),d=mesh.userData.dimensions||{x:1,y:1,z:1};mesh.scale.setScalar(size/Math.max(d.x,d.y,d.z));return mesh;}
function thumb(id,food=false,width=144){const key=id+(food?'food':'')+width;if(thumbnails.has(key))return thumbnails.get(key);
 const r=new THREE.WebGLRenderer({alpha:true,antialias:true});r.setSize(width,Math.round(width*88/112));r.outputColorSpace=THREE.SRGBColorSpace;r.toneMapping=THREE.ACESFilmicToneMapping;r.toneMappingExposure=1.08;const s=new THREE.Scene();s.add(new THREE.HemisphereLight('#fff4da','#718782',1.4));const l=new THREE.DirectionalLight('#ffe9c2',3);l.position.set(-2,4,4);s.add(l);const c=new THREE.PerspectiveCamera(32,112/88,.1,20);c.position.set(2,1.5,3.7);c.lookAt(0,0,0);const m=food?createFood(id):createIngredient(id),d=m.userData.dimensions;m.scale.setScalar(1.8/Math.max(d.x,d.y,d.z));s.add(m);r.render(s,c);const url=r.domElement.toDataURL();r.dispose();r.forceContextLoss();thumbnails.set(key,url);return url;
}
function entryId(entry){return typeof entry==='string'?entry:entry.id;}
function entryMode(entry){return typeof entry==='string'?'split':entry.mode;}
function packAvailable(pack){return !liveAllowed||liveAllowed.has(pack.id);}
function appendReferencePrice(parent,pack){
 if(!priceSnapshot)return;const item=priceSnapshot.products.find(p=>p.packId===pack.id),note=document.createElement('small');note.className='reference-price';
 note.textContent=Number.isFinite(item?.publicPriceYuan)?`门店参考 ¥${item.publicPriceYuan.toFixed(2)}`:pack.id==='breakfast'?'游戏补给':'门店价格待核验';parent.append(note);
}
function applyMenuSnapshot(snapshot){
 priceSnapshot=snapshot;const label=$('menuReference');label.hidden=!snapshot;
 if(snapshot){const stamp=snapshot.retrievedAt?new Date(snapshot.retrievedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'时间待核验';label.textContent=`参考门店：${snapshot.store?.name||'待选择'} · ${stamp} · 金币为游戏定价`;}
 renderPrep();if($('shopDialog').open)renderShop();
}
function renderPrep(){
 $('packList').replaceChildren();
 for(const pack of PACKS){const entries=selection.filter(e=>entryId(e)===pack.id),count=entries.length,mode=entries[0]?entryMode(entries[0]):'split';const row=document.createElement('div');row.className='pack-row'+(count?' is-picked':'');row.dataset.pack=pack.id;
 const description=mode==='whole'?'整堡保留 → 汉堡炸弹 ×1':Object.entries(pack.ingredients).map(([id,n])=>`${ingredientById.get(id).name}×${n}`).join(' · ');
 row.innerHTML=`<img src="${thumb(pack.model,true)}" alt=""><div class="pack-copy"><strong>${pack.name}</strong><span>${description}</span></div><span class="pack-price">${pack.cost}</span><div class="quantity-control"><button type="button" data-delta="-1" aria-label="减少${pack.name}">−</button><output>${count}</output><button type="button" data-delta="1" aria-label="增加${pack.name}">+</button></div>`;
 const copy=row.querySelector('.pack-copy');appendReferencePrice(copy,pack);if(['bigmac','spicy','fish','breakfast'].includes(pack.id)){const b=document.createElement('button');b.className='pack-mode';b.type='button';b.dataset.mode=mode;b.textContent=mode==='whole'?'整堡炸弹 ⇄':'拆成食材 ⇄';b.setAttribute('aria-label',`${pack.name}，${mode==='whole'?'切换为拆食材':'保留整堡炸弹'}`);b.disabled=!packAvailable(pack);b.addEventListener('click',()=>{const next=mode==='whole'?'split':'whole',candidate=count?selection.map(e=>entryId(e)===pack.id?{id:pack.id,mode:next}:e):[...selection,{id:pack.id,mode:next}];if(!buildInventory(candidate).ok){toast('金币不足');return;}selection=candidate;renderPrep();});copy.append(b);}
 for(const b of row.querySelectorAll('[data-delta]')){const delta=+b.dataset.delta;b.disabled=delta<0?!count:!packAvailable(pack)||!buildInventory([...selection,{id:pack.id,mode}]).ok;b.addEventListener('click',()=>{if(delta>0)selection.push({id:pack.id,mode});else{const i=selection.findIndex(e=>entryId(e)===pack.id);selection.splice(i,1);}renderPrep();});}
 if(!packAvailable(pack))row.classList.add('is-unavailable');$('packList').append(row);
 }
 const loadout=buildInventory(selection);$('supplyUsed').textContent=loadout.spent;$('startButton').disabled=!loadout.ok||!Object.values(loadout.inventory).some(Boolean);$('loadoutPreview').replaceChildren();
 for(const ingredient of INGREDIENTS){const n=loadout.inventory[ingredient.id]||0;if(!n)continue;const v=document.createElement('span');v.title=`${ingredient.name} ×${n}`;v.innerHTML=`<img src="${thumb(ingredient.id)}" alt="${ingredient.name}"><small>×${n}</small>`;$('loadoutPreview').append(v);}
}
function addNode(ingredient,x,y,z,size=1.1,rotation=0,roof=false){const id='food-'+nodes.length,mesh=new THREE.Group(),food=ingredientMesh(ingredient,size*.9);mesh.add(food);if(!roof){food.position.z=.19;if(['bun','patty','onion'].includes(ingredient))food.rotation.x=Math.PI/2;const panel=box(size*.99,size*.89,.3,nodes.length%2?'#fff0cb':'#f3dca6',0,0,-.2,.09);mesh.add(panel);}mesh.position.set(x,y,z);mesh.rotation.z=rotation;mesh.traverse(m=>{if(m.isMesh){m.castShadow=true;m.receiveShadow=true;}});castle.add(mesh);
 const proxy=new THREE.Mesh(new THREE.BoxGeometry(size*.96,size*.88,.82),new THREE.MeshBasicMaterial({visible:false}));proxy.position.set(x,y,z);proxy.userData.nodeId=id;castle.add(proxy);const node={id,ingredient,x,y,z,hp:1,removed:false,mesh,proxy,size,baseRotation:rotation};nodes.push(node);return node;}
function rebuildCastle(){castle.clear();nodes=[];decor=[];
 castle.add(box(12,.25,4.5,'#f1ddad',0,.14,0));
 const layout=[['nugget','nugget','bun','patty','bun','patty','fry','fry'],['nugget','nugget','bun','onion','bun','onion','fry','fry'],['ketchup','ketchup','bun','patty','bun','patty','sausage','sausage'],['ketchup','ketchup','bun','bun','bun','bun','sausage','sausage']];
 for(let row=0;row<4;row++)for(let col=0;col<8;col++)addNode(layout[row][col],(col-3.5)*1.27,.8+row*1.08,1.05,1.16,(col%2?1:-1)*.035);
 // Food wings, windows and sloping bun roof make a single restaurant silhouette.
 for(const side of [-1,1]){for(let j=0;j<3;j++)addNode(j===1?'nugget':'fry',side*5.05,.85+j*1.18,.2,1.2,side*.07);const window=box(2.2,2.6,.18,'#244c51',side*2.5,2.2,.42);decor.push(window);castle.add(window);}
 for(let col=0;col<8;col++)addNode('bun',(col-3.5)*1.36,5.02+(3.5-Math.abs(col-3.5))*.18,.8,1.42,(col<4?.15:-.15),true);
 const fascia=box(10.5,.62,.55,'#cd302b',0,4.55,.53);castle.add(fascia);decor.push(fascia);
 const name=sign('ABC',2.1,.72,0,4.58,1.38);castle.add(name);decor.push(name);
 for(let i=0;i<12;i++){const stripe=box(.74,.13,1.3,i%2?'#fff3cf':'#d6342b',(i-5.5)*.83,4.23,1.37,.02);stripe.rotation.x=.14;castle.add(stripe);decor.push(stripe);}
 const bucket=createFood('bucket');bucket.scale.setScalar(1.08);bucket.position.set(0,6.45,-.1);castle.add(bucket);decor.push(bucket);
 for(const side of [-1,1]){
   const tart=createFood('tart');tart.scale.setScalar(.85);tart.position.set(side*5.25,4.92,.42);castle.add(tart);decor.push(tart);
   const chicken=createFood('chicken');chicken.scale.setScalar(1.1);chicken.position.set(side*3.45,6.23,-.12);chicken.rotation.z=side*.32;castle.add(chicken);decor.push(chicken);
 }
 const door=box(1.8,2.3,.12,'#1e4146',0,1.38,.35);castle.add(door);decor.push(door);
 totalNodes=nodes.length;goal=Math.ceil(totalNodes*.76);removedCount=0;
}
function refreshChamber(){
 if(chamber)launcher.remove(chamber);chamber=ingredientMesh(selected,.86);
 chamber.position.copy(launcher.getObjectByName('launcher-chamber').position);chamber.position.y+=.18;chamber.visible=!!inventory[selected];launcher.add(chamber);
 updateWeapon();
}
function updateWeapon(){
 const ingredient=ingredientById.get(selected),qty=inventory[selected]||0;
 $('weaponIcon').src=thumb(selected);$('weaponName').textContent=ingredient.name;$('weaponCount').textContent=qty?String(qty).padStart(2,'0'):'空仓';$('weaponReadout').classList.toggle('is-empty',!qty);
 displayContext.fillStyle='#182a2a';displayContext.fillRect(0,0,512,256);displayContext.fillStyle=qty?'#ffbc0d':'#bcbcbc';displayContext.fillRect(16,18,8,220);
 displayContext.textAlign='left';displayContext.fillStyle='#a3b8b1';displayContext.font='600 27px Arial';displayContext.fillText('LOADED / 当前装填',42,53);
 displayContext.fillStyle='#fff7dd';displayContext.font='bold 56px Arial, sans-serif';displayContext.fillText(ingredient.name,42,136,320);displayContext.font='900 76px Arial';displayContext.textAlign='right';displayContext.fillStyle=qty?'#ffbc0d':'#fa6d4b';displayContext.fillText(String(qty).padStart(2,'0'),474,216);displayContext.textAlign='left';displayContext.fillStyle=ingredient.color;displayContext.fillRect(42,178,128,24);displayTexture.needsUpdate=true;
 if(chamber)chamber.visible=qty>0;
}
function renderBattle(){
 $('roundProgress').textContent=`${Math.min(removedCount,goal)} / ${goal}`;$('coinCount').textContent=economy.coins;
 const remaining=Object.values(inventory).reduce((a,b)=>a+b,0);$('shotsCount').textContent=remaining+' 发';$('ingredientBar').replaceChildren();
 $('ammoEmptyHint').hidden=remaining>0||phase!=='battle';
 $('shopButton').disabled=phase!=='battle';$('shopButton').setAttribute('aria-label',`补给商店，余额 ${economy.coins} 金币`);
 $('weaponReadout').hidden=phase==='prep';
 for(const ingredient of INGREDIENTS){if(!ownedAmmo.has(ingredient.id))continue;const qty=inventory[ingredient.id]||0,b=document.createElement('button');b.type='button';b.className='ingredient-button'+(ingredient.id===selected?' is-selected':'');b.dataset.ingredient=ingredient.id;b.disabled=!qty;b.setAttribute('aria-pressed',String(ingredient.id===selected));b.setAttribute('aria-label',`${ingredient.name}，剩余${qty}发`);b.innerHTML=`<img src="${thumb(ingredient.id)}" alt=""><strong>${ingredient.name}</strong><small>${qty}</small>`;b.addEventListener('click',()=>{if(phase!=='battle')return;selected=ingredient.id;refreshChamber();renderBattle();});$('ingredientBar').append(b);}
 updateWeapon();
}
function renderShop(){
 $('shopBalance').textContent=economy.coins;$('shopList').replaceChildren();
 for(const pack of PACKS){const mode=shopModes.get(pack.id)||'split',row=document.createElement('div');row.className='shop-row';row.dataset.shopPack=pack.id;
 const recipe=mode==='whole'?'汉堡炸弹 ×1':Object.entries(pack.ingredients).map(([id,n])=>`${ingredientById.get(id).name} ×${n}`).join(' · ');
 row.innerHTML=`<img src="${thumb(pack.model,true)}" alt=""><div class="shop-copy"><strong>${pack.name}</strong><span>${recipe}</span></div>`;
 appendReferencePrice(row.querySelector('.shop-copy'),pack);
 if(['bigmac','spicy','fish','breakfast'].includes(pack.id)){const modes=document.createElement('div');modes.className='shop-modes';for(const [id,label] of [['split','拆成食材'],['whole','整堡炸弹']]){const option=document.createElement('button');option.className='shop-mode';option.type='button';option.textContent=label;option.dataset.mode=id;option.setAttribute('aria-pressed',String(mode===id));option.addEventListener('click',()=>{shopModes.set(pack.id,id);renderShop();});modes.append(option);}row.querySelector('.shop-copy').append(modes);}
 const buy=document.createElement('button');buy.type='button';buy.className='shop-buy';buy.dataset.buy=pack.id;const available=packAvailable(pack),short=Math.max(0,pack.cost-economy.coins);buy.disabled=!available||short>0||phase!=='battle';buy.innerHTML=!available?'目录未收录':short?`还差 <b>${short}</b> 金币`:`<b>${pack.cost}</b> 金币 · 补给`;buy.setAttribute('aria-label',`购买${pack.name}，${mode==='whole'?'整堡炸弹':'拆成食材'}，${pack.cost}金币`);buy.addEventListener('click',()=>buyPack(pack.id,mode));row.append(buy);
 if(purchaseReceipts.get(pack.id)>performance.now())row.classList.add('is-bought');$('shopList').append(row);
 }
}
function buyPack(id,mode){
 if(phase!=='battle')return;const result=purchasePack(economy,inventory,{id,mode,allowedPackIds:liveAllowed});
 if(!result.ok){$('shopMessage').textContent=result.error;$('shopMessage').className='is-error';return;}
 economy=result.state;inventory=result.inventory;for(const [key,n] of Object.entries(result.added))if(n>0)ownedAmmo.add(key);
 if(!inventory[selected])selected=INGREDIENTS.find(a=>inventory[a.id]>0).id;refreshChamber();renderBattle();purchaseReceipts.set(id,performance.now()+1600);renderShop();restockNotified=false;
 const count=Object.values(result.added).reduce((sum,n)=>sum+n,0);$('shopMessage').className='is-success';$('shopMessage').textContent=`已装填 ${count} 发 · 花费 ${result.spent} 金币 · 余额 ${economy.coins}`;sound('combo');
}
function openShop(){if(phase!=='battle')return;cancelPointer();$('shopMessage').className='';$('shopMessage').textContent='选择套餐，即刻装填。关闭商店继续射击。';renderShop();$('shopDialog').showModal();}
function closeShop(){if($('shopDialog').open)$('shopDialog').close();cancelPointer();if(phase==='battle')toast('补给就绪，继续射击');}
function coinFeedback(amount,position){
 if(!amount)return;const start=project({x:position.x,y:position.y,z:position.z}),wallet=$('coinCount').getBoundingClientRect(),end={x:wallet.x+wallet.width/2,y:wallet.y+wallet.height/2};
 const popup=document.createElement('span');popup.className='coin-popup';popup.textContent=`+${amount} 金币`;popup.style.left=start.x+'px';popup.style.top=start.y+'px';$('coinFlyLayer').append(popup);setTimeout(()=>popup.remove(),1100);
 if(!reduced){for(let i=0;i<Math.min(6,Math.ceil(amount/3));i++){const coin=document.createElement('span');coin.className='coin-fly';coin.textContent='•';$('coinFlyLayer').append(coin);coin.style.left='0';coin.style.top='0';const anim=coin.animate([{transform:`translate(${start.x}px,${start.y}px) scale(1)`},{transform:`translate(${(start.x+end.x)/2+(i-2)*13}px,${Math.min(start.y,end.y)-35-i*5}px) scale(1.15)`,offset:.5},{transform:`translate(${end.x}px,${end.y}px) scale(.35)`,opacity:.1}],{duration:600+i*55,easing:'cubic-bezier(.2,.7,.3,1)',fill:'forwards'});anim.onfinish=()=>coin.remove();}}
 const group=$('coinCount').closest('.battle-wallet');group?.classList.add('is-gaining');setTimeout(()=>group?.classList.remove('is-gaining'),650);
}
function resetEffects(){for(const p of projectiles)scene.remove(p.mesh);for(const d of debris)scene.remove(d.mesh);projectiles=[];debris=[];fx.reset();flash.intensity=0;recoil=shake=0;}
function start(){const loadout=payLoadout(createEconomy(),selection,{allowedPackIds:liveAllowed});if(!loadout.ok||!Object.values(loadout.inventory).some(Boolean))return;clearTimeout(resultTimer);resetEffects();rebuildCastle();economy=loadout.state;inventory={...loadout.inventory};ownedAmmo=new Set(Object.keys(inventory).filter(id=>inventory[id]>0));restockNotified=false;purchaseReceipts.clear();selected=INGREDIENTS.find(i=>inventory[i.id]>0).id;shots=comboCount=0;phase='battle';$('prepScreen').hidden=true;$('battleHud').hidden=false;$('resultDialog').close();launcher.visible=true;refreshChamber();renderBattle();resize();toast('同料连消 · 蘸酱组合 · 整堡爆破');}
function backToPrep(){phase='prep';pointer=null;$('shopDialog').close();$('weaponReadout').hidden=true;$('coinFlyLayer').replaceChildren();economy=createEconomy();clearTimeout(resultTimer);$('resultDialog').close();$('battleHud').hidden=true;$('prepScreen').hidden=false;launcher.visible=false;resetEffects();rebuildCastle();renderPrep();resize();}
function setAim(x,y){aimScreen.x=THREE.MathUtils.clamp(x,12,innerWidth-12);aimScreen.y=THREE.MathUtils.clamp(y,70,innerHeight-90);aim.set(aimScreen.x/innerWidth*2-1,1-aimScreen.y/innerHeight*2);$('crosshair').style.left=aimScreen.x+'px';$('crosshair').style.top=aimScreen.y+'px';$('aimLabel').style.left=aimScreen.x+'px';$('aimLabel').style.top=(aimScreen.y+30)+'px';}
function picked(){raycaster.setFromCamera(aim,camera);const hit=raycaster.intersectObjects(nodes.filter(n=>!n.removed).map(n=>n.proxy),false)[0];return hit?{node:nodes.find(n=>n.id===hit.object.userData.nodeId),point:hit.point}:null;}
function shoot(){if(phase!=='battle'||projectiles.length>=2||document.querySelector('dialog[open]'))return;const consume=consumeShot(inventory,selected);if(!consume.ok)return;inventory=consume.inventory;const hit=picked(),ammo=selected,mesh=ingredientMesh(ammo,ammo==='burgerbomb'?.74:.45),origin=launcher.getObjectByName('launcher-muzzle').getWorldPosition(new THREE.Vector3());raycaster.setFromCamera(aim,camera);const destination=hit?.point||raycaster.ray.at(28,new THREE.Vector3());mesh.position.copy(origin);scene.add(mesh);projectiles.push({mesh,ammo,origin,destination,age:0,duration:origin.distanceTo(destination)/(ammo==='burgerbomb'?27:43),targetId:hit?.node.id,previous:origin.clone()});shots++;recoil=.12;sound();
 if(!inventory[selected]){selected=INGREDIENTS.find(i=>inventory[i.id]>0)?.id||selected;refreshChamber();}renderBattle();}
function burstNode(node,type){if(node.removed)return;node.removed=true;node.proxy.visible=false;removedCount++;const p=[node.x,node.y,node.z];fx.impact({position:p,strength:type==='bomb'?1.3:.6,color:ingredientById.get(node.ingredient).color,kind:node.ingredient==='ketchup'?'slide':'heavy',foodModel:node.ingredient});
 castle.remove(node.mesh);scene.add(node.mesh);debris.push({mesh:node.mesh,velocity:new THREE.Vector3((Math.random()-.5)*6,3+Math.random()*3,3+Math.random()*3),angular:new THREE.Vector3(Math.random()*3,Math.random()*3,Math.random()*3),life:1.25,age:0,scale:node.mesh.scale.clone()});}
function collision(projectile,point,target){const color=ingredientById.get(projectile.ammo).color;flash.position.copy(point).add(new THREE.Vector3(0,.4,.8));flash.intensity=reduced?0:16;shake=reduced?0:.035;fx.impact({position:point.toArray(),strength:projectile.ammo==='burgerbomb'?1.5:.7,color,kind:projectile.ammo==='ketchup'?'slide':'heavy',foodModel:projectile.ammo});sound('impact');
 if(!target||target.removed){toast('打空了，找准食材再来');return;}
 const outcome=resolveHit({ammo:projectile.ammo,target,neighbors:nodes});
 if(outcome.removeIds.length){const reward=earnCoins(economy,outcome.removeIds,{combo:outcome.type==='combo'});economy=reward.state;coinFeedback(reward.earned,point);for(const id of outcome.removeIds){const n=nodes.find(n=>n.id===id);if(n)burstNode(n,outcome.type);}if(outcome.type==='combo'||outcome.type==='bomb'){comboCount++;sound('combo');if(!reduced)hitPause=.075;fx.ability({kind:'burst',position:point.toArray(),color,ammoId:projectile.ammo});if(outcome.type==='combo'){const result=ingredientMesh(outcome.combo==='burger'?'burgerbomb':outcome.combo==='dip'?'fry':'bun',1.25);result.position.copy(point).add(new THREE.Vector3(0,.2,1));scene.add(result);debris.push({mesh:result,velocity:new THREE.Vector3(0,3,1),angular:new THREE.Vector3(0,3,0),life:.7,age:0,scale:result.scale.clone()});}}
 $('comboLabel').textContent=`${outcome.label}${outcome.removeIds.length>1?' ×'+outcome.removeIds.length:''}`;$('comboLabel').classList.remove('pop');void $('comboLabel').offsetWidth;$('comboLabel').classList.add('pop');clearTimeout(comboTimer);comboTimer=setTimeout(()=>$('comboLabel').textContent='',1500);
 }else{target.mesh.position.z+=.12;target.wobble=.35;toast(`${ingredientById.get(projectile.ammo).name} × ${ingredientById.get(target.ingredient).name}：换个搭配`);}renderBattle();
 if(removedCount>=goal&&phase==='battle'){phase='won';const finishReward=earnCoins(economy,nodes.filter(n=>!n.removed).map(n=>n.id));economy=finishReward.state;if(finishReward.earned)coinFeedback(finishReward.earned,new THREE.Vector3(0,4,1));for(const n of nodes)if(!n.removed)burstNode(n,'bomb');for(const mesh of decor){castle.remove(mesh);scene.add(mesh);debris.push({mesh,velocity:new THREE.Vector3((Math.random()-.5)*8,4+Math.random()*3,2),angular:new THREE.Vector3(1,2,1),life:2,age:0,scale:mesh.scale.clone()});}renderBattle();resultTimer=setTimeout(()=>showResult(true),1450);}
}
function showResult(won){$('resultTitle').textContent=won?'ABC 食物餐厅，开花了！':'再配一餐！';$('resultDetail').textContent=won?'同料连消、配方合体，这餐打得漂亮。':'弹药用完了。根据墙上的食材，换一份配置再来。';$('resultStats').innerHTML=`<div><strong>${economy.earned}</strong><span>金币入账</span></div><div><strong>${shots}</strong><span>发食材</span></div><div><strong>${comboCount}</strong><span>次组合爆破</span></div><div><strong>${removedCount}</strong><span>块食材清除</span></div>`;$('resultDialog').showModal();}
canvas.addEventListener('pointerdown',e=>{if(phase!=='battle'||e.button!==0||pointer)return;pointer={id:e.pointerId};setAim(e.clientX,e.clientY);canvas.setPointerCapture(e.pointerId);$('crosshair').classList.add('aiming');});
canvas.addEventListener('pointermove',e=>{if(phase!=='battle')return;if(e.pointerType==='mouse'||pointer?.id===e.pointerId)setAim(e.clientX,e.clientY);});
canvas.addEventListener('pointerup',e=>{if(pointer?.id!==e.pointerId)return;pointer=null;$('crosshair').classList.remove('aiming');shoot();});
function cancelPointer(){pointer=null;$('crosshair').classList.remove('aiming');}
canvas.addEventListener('pointercancel',cancelPointer);canvas.addEventListener('lostpointercapture',cancelPointer);addEventListener('blur',cancelPointer);document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelPointer();});
$('shopButton').addEventListener('click',openShop);$('shopClose').addEventListener('click',closeShop);$('shopContinue').addEventListener('click',closeShop);$('shopDialog').addEventListener('close',cancelPointer);
$('startButton').addEventListener('click',start);$('backToPrep').addEventListener('click',backToPrep);$('retryButton').addEventListener('click',backToPrep);$('helpButton').addEventListener('click',()=>$('helpDialog').showModal());$('dataButton').addEventListener('click',()=>$('dataDialog').showModal());$('soundButton').addEventListener('click',()=>{soundEnabled=!soundEnabled;$('soundButton').setAttribute('aria-pressed',String(soundEnabled));});for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>b.closest('dialog').close());
$('shareButton').addEventListener('click',async()=>{const text=`《吃我一发麦麦》战报：${shots}发食材，${comboCount}次组合，清掉${removedCount}块 ABC 食物建筑！`;try{await navigator.clipboard.writeText(text);$('shareButton').textContent='已复制';}catch{toast(text);}});
addEventListener('keydown',e=>{if(e.code==='KeyB'&&!e.repeat&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){if($('shopDialog').open)closeShop();else if(!document.querySelector('dialog[open]'))openShop();return;}if(document.querySelector('dialog[open]')||['INPUT','TEXTAREA'].includes(document.activeElement.tagName))return;if(e.code==='Space'){e.preventDefault();if(!e.repeat)shoot();}if(/^Digit[1-8]$/.test(e.code)){const a=INGREDIENTS[+e.code.slice(-1)-1];if(a&&inventory[a.id]){selected=a.id;refreshChamber();renderBattle();}}});
function resize(){cancelPointer();renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;const portrait=innerHeight>innerWidth;camera.fov=portrait?58:48;camera.position.set(0,3.5,portrait?23:13.4);camera.lookAt(0,2.95,.4);camera.updateProjectionMatrix();camera.updateMatrixWorld();launcher.position.set(portrait?.32:.63,portrait?-.73:-.58,-1.4);launcher.scale.setScalar(portrait?.24:.28);setAim(innerWidth/2,innerHeight*.45);}
addEventListener('resize',resize);
function project(node){const p=new THREE.Vector3(node.x,node.y,node.z).project(camera);return {x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2};}
function animate(now){let dt=Math.min((now-last)/1000,.045);last=now;const paused=!!document.querySelector('dialog[open]')||document.hidden;if(paused)dt=0;if(hitPause>0){hitPause-=dt;dt*=.2;}
 for(const p of [...projectiles]){p.age+=dt;const t=Math.min(1,p.age/p.duration);p.mesh.position.lerpVectors(p.origin,p.destination,t);p.mesh.position.y+=Math.sin(t*Math.PI)*(p.ammo==='burgerbomb'?.5:.07);p.mesh.rotation.x+=dt*8;p.mesh.rotation.z+=dt*5;
 const delta=p.mesh.position.clone().sub(p.previous),distance=delta.length();let contact=null;if(distance>0){raycaster.set(p.previous,delta.normalize());raycaster.far=distance+.15;contact=raycaster.intersectObjects(nodes.filter(n=>!n.removed).map(n=>n.proxy),false)[0];raycaster.far=Infinity;}
 if(contact||t>=1){const target=contact?nodes.find(n=>n.id===contact.object.userData.nodeId):nodes.find(n=>n.id===p.targetId&&!n.removed);collision(p,contact?.point||p.destination,target);scene.remove(p.mesh);projectiles.splice(projectiles.indexOf(p),1);}else p.previous.copy(p.mesh.position);}
 for(const d of [...debris]){d.age+=dt;d.velocity.y-=12*dt;d.mesh.position.addScaledVector(d.velocity,dt);d.mesh.rotation.x+=d.angular.x*dt;d.mesh.rotation.y+=d.angular.y*dt;d.mesh.rotation.z+=d.angular.z*dt;const k=Math.max(0,1-(d.age/d.life)**3);d.mesh.scale.copy(d.scale).multiplyScalar(k);if(d.age>=d.life){scene.remove(d.mesh);debris.splice(debris.indexOf(d),1);}}
 for(const n of nodes)if(n.wobble>0){n.wobble-=dt;n.mesh.position.z=n.z+Math.sin(n.wobble*40)*n.wobble*.3;}
 if(phase==='battle'&&!projectiles.length&&!Object.values(inventory).some(Boolean)){if(canRestock(economy,liveAllowed)){if(!restockNotified){restockNotified=true;toast('弹药用完了，去补给商店装填');renderBattle();}}else{phase='lost';renderBattle();resultTimer=setTimeout(()=>showResult(false),700);}}
 recoil=Math.max(0,recoil-dt*.5);launcher.position.z=-1.4+recoil;launcher.rotation.y=-.08-aim.x*.16;launcher.rotation.x=aim.y*.1;flash.intensity=Math.max(0,flash.intensity-dt*55);fx.update(dt);
 if(phase!=='prep'){const anchor=launcher.getObjectByName('launcher-display-anchor').getWorldPosition(new THREE.Vector3()),pos=project({x:anchor.x,y:anchor.y,z:anchor.z});const readout=$('weaponReadout'),width=readout.offsetWidth||170;readout.style.left=THREE.MathUtils.clamp(pos.x,8+width/2,innerWidth-width/2-8)+'px';readout.style.top=THREE.MathUtils.clamp(pos.y-75,130,innerHeight-155)+'px';}
 if(phase==='battle'){const hit=picked(),outcome=hit?resolveHit({ammo:selected,target:hit.node,neighbors:nodes}):null;const valid=!!outcome?.removeIds.length;$('crosshair').classList.toggle('can-match',valid);$('aimLabel').textContent=hit?`${ingredientById.get(hit.node.ingredient).name} · ${valid?outcome.label:'换种食材'}`:'拖动瞄准 · 松手发射';}
 const cameraBase=camera.position.clone();if(shake>0&&!reduced){camera.position.x+=Math.sin(now*.075)*shake;camera.position.y+=Math.cos(now*.09)*shake;camera.updateMatrixWorld();}renderer.render(scene,camera);camera.position.copy(cameraBase);camera.updateMatrixWorld();shake=Math.max(0,shake-dt*.2);requestAnimationFrame(animate);}
rebuildCastle();renderPrep();for(const [id,model] of [['heroBurger','bigmac'],['heroFries','fries'],['heroNuggets','nuggets']]){if($(id))$(id).src=thumb(model,true,384);}launcher.visible=false;resize();$('loading').remove();requestAnimationFrame(animate);
window.__burgerGame={get state(){return {phase,selected,inventory:{...inventory},shots,removed:removedCount,goal,total:totalNodes,combos:comboCount,projectiles:projectiles.length,coins:economy.coins,earned:economy.earned,spent:economy.spent,shopOpen:$('shopDialog').open,source:liveAllowed?'official-nutrition-catalog':'demo-game-conversion'};},get targets(){return nodes.filter(n=>!n.removed).map(n=>({id:n.id,ingredient:n.ingredient,...project(n)}));},get nodes(){return nodes.map(({id,ingredient,x,y,z,removed})=>({id,ingredient,x,y,z,removed}));},get sceneStats(){return {drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,fx:fx.stats};},get selection(){return [...selection];},applyLiveCatalog(info){liveAllowed=new Set(info.map(x=>x.id));selection=selection.filter(e=>liveAllowed.has(entryId(e)));backToPrep();},clearLiveCatalog(){liveAllowed=null;backToPrep();}};
setupMcpUI({onLive:info=>window.__burgerGame.applyLiveCatalog(info),onDemo:()=>window.__burgerGame.clearLiveCatalog(),onMenu:applyMenuSnapshot,getSelection:()=>selection});
