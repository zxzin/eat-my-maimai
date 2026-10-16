import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import './style.css';
import { createFood } from './food-models.js';
import { createIngredient, createFoodLauncher } from './ingredient-models.js';
import { createImpactFX } from './impact-fx.js';
import { syncRendererResolution, watchDisplayDensity } from './display-resolution.js';
import { createHoldFire, fireInterval } from './fire-control.js';
import { createGameGuide } from './game-guide.js';
import { createCombatFeedback } from './combat-feedback.js';
import { createFoodPlaza } from './plaza-environment.js';
import { buildRestaurantStage } from './restaurant-stage.js';
import { createBuildingDamage } from './building-damage.js';
import { resolveStageHit, isStageComplete } from './stage-rules.js';
import { INGREDIENTS, PACKS, DEFAULT_PACK_IDS, buildInventory, consumeShot, CORN_HITS_TO_CLEAR } from './ingredient-rules.js';
import { setupMcpUI } from './mcp-ui.js';
import { createEconomy, payLoadout, earnCoins, purchasePack, canRestock, purchaseCorn, STARTER_CORN, CORN_REFILL_COST, CORN_REFILL_AMOUNT } from './economy.js';

const $=id=>document.getElementById(id),canvas=$('gameCanvas');
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NeutralToneMapping;renderer.toneMappingExposure=1;
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(50,1,.05,100);scene.add(camera);
const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();scene.environment=pmrem.fromScene(room,.08).texture;scene.environmentIntensity=.18;room.dispose();pmrem.dispose();
scene.add(new THREE.HemisphereLight('#def6ff','#263f49',.82));
const sun=new THREE.DirectionalLight('#fff4dd',2.65);sun.position.set(-8,13,10);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-14,right:14,top:14,bottom:-10,far:45});sun.shadow.bias=-.00025;sun.shadow.normalBias=.035;sun.shadow.radius=3;scene.add(sun);
const rim=new THREE.DirectionalLight('#ffd371',1.4);rim.position.set(8,7,-7);scene.add(rim);
const fill=new THREE.DirectionalLight('#80cfff',.35);fill.position.set(7,3,8);scene.add(fill);
const flash=new THREE.PointLight('#ffad55',0,12,1.7);scene.add(flash);
const fx=createImpactFX(scene,{reducedMotion:reduced,floorAt:(x,z)=>Math.abs(x)<6&&Math.abs(z)<2.25?.273:Math.abs(x)<7.5&&Math.abs(z)<4?.108:-.045});
const materials=new Map(),geometries=new Map();
function mat(color,roughness=.65){const key=color+roughness;if(!materials.has(key))materials.set(key,new THREE.MeshStandardMaterial({color,roughness}));return materials.get(key);}
function box(w,h,d,color,x,y,z,r=.06){const key=[w,h,d,r].join();if(!geometries.has(key))geometries.set(key,new RoundedBoxGeometry(w,h,d,2,r));const m=new THREE.Mesh(geometries.get(key),mat(color));m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;return m;}
function labelTexture(text,color='#ffffff',bg='#d9232e',w=512,h=160){const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);ctx.fillStyle=color;ctx.font=`900 ${h*.65}px "Arial Black", "PingFang SC", sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,w/2,h*.54);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;}
function sign(text,w,h,x,y,z){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,.18),new THREE.MeshStandardMaterial({map:labelTexture(text),roughness:.8}));m.position.set(x,y,z);m.castShadow=true;return m;}
createFoodPlaza({scene,anisotropy:Math.min(8,renderer.capabilities.getMaxAnisotropy())});
const castle=new THREE.Group();scene.add(castle);
const launcher=createFoodLauncher();camera.add(launcher);launcher.position.set(.58,-.58,-1.4);launcher.rotation.y=-.08;launcher.scale.setScalar(.28);
let chamber=null,phase='prep',selected='bun',inventory={},selection=[...DEFAULT_PACK_IDS],liveAllowed=null;
let priceSnapshot=null,expandedPackId=null;
let economy=createEconomy(),ownedAmmo=new Set(),restockNotified=false;
const shopModes=new Map(),purchaseReceipts=new Map();
const displayCanvas=document.createElement('canvas');displayCanvas.width=1024;displayCanvas.height=512;
const displayContext=displayCanvas.getContext('2d'),displayTexture=new THREE.CanvasTexture(displayCanvas);displayTexture.colorSpace=THREE.SRGBColorSpace;displayTexture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
const gunDisplay=launcher.getObjectByName('launcher-display');gunDisplay.material.map=displayTexture;gunDisplay.material.needsUpdate=true;
let buildingDamage=null,structureParts=[],structureById=new Map(),victoryTime=0,victoryPresented=false;
let nodes=[],decor=[],setpieces=[],projectiles=[],debris=[],pendingBursts=[],removedCount=0,shots=0,comboCount=0,totalNodes=0,goal=0,streak=0,bestStreak=0,misses=0,stageSeed=0,last=performance.now(),recoil=0,shake=0,hitPause=0,pointer=null,spaceFiring=false,loadProgress=1,toastTimer,comboTimer,resultTimer,hitFlashTimer,soundEnabled=true,audioContext;
const combatFeedback=createCombatFeedback(scene,{reducedMotion:reduced,getAudioContext:()=>audioContext||null,enabled:()=>soundEnabled});
const thumbnails=new Map(),raycaster=new THREE.Raycaster(),aim=new THREE.Vector2(),aimScreen={x:innerWidth/2,y:innerHeight*.45};
const ingredientById=new Map(INGREDIENTS.map(a=>[a.id,a]));
const holdFire=createHoldFire();
const guide=createGameGuide({root:$('gameGuide'),prepRoot:$('prepGuide'),getTarget:step=>step==='prep'?$('startButton'):step==='select'?document.querySelector('[data-ingredient="corn"]'):step==='fire'?canvas:step==='mechanism'?$('setpieceGoals'):$('ingredientBar')});
function toast(text){$('toast').textContent=text;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').textContent='',2200);}
function activateAudio(){try{if(soundEnabled){audioContext??=new(window.AudioContext||window.webkitAudioContext)();audioContext.resume();}}catch{}}
function sound(kind='fire'){
 if(!soundEnabled)return;try{audioContext??=new(window.AudioContext||window.webkitAudioContext)();audioContext.resume();const t=audioContext.currentTime,g=audioContext.createGain(),o=audioContext.createOscillator();g.connect(audioContext.destination);g.gain.setValueAtTime(kind==='impact'?.12:.06,t);g.gain.exponentialRampToValueAtTime(.001,t+.22);o.type=kind==='fire'?'sine':'triangle';o.frequency.setValueAtTime(kind==='combo'?560:kind==='fire'?210:110,t);o.frequency.exponentialRampToValueAtTime(kind==='combo'?940:55,t+.2);o.connect(g);o.start(t);o.stop(t+.22);}catch{}
}
function ingredientMesh(id,size=1){const mesh=createIngredient(id),d=mesh.userData.dimensions||{x:1,y:1,z:1};mesh.scale.setScalar(size/Math.max(d.x,d.y,d.z));return mesh;}
function thumb(id,food=false,width=144){const key=id+(food?'food':'')+width;if(thumbnails.has(key))return thumbnails.get(key);
 const r=new THREE.WebGLRenderer({alpha:true,antialias:true});r.setSize(width,Math.round(width*88/112));r.outputColorSpace=THREE.SRGBColorSpace;r.toneMapping=THREE.NeutralToneMapping;r.toneMappingExposure=1;const s=new THREE.Scene();s.add(new THREE.HemisphereLight('#f2faff','#34404b',1.1));const l=new THREE.DirectionalLight('#fff5e5',2.6);l.position.set(-2,4,4);s.add(l);const c=new THREE.PerspectiveCamera(32,112/88,.1,20);c.position.set(2,1.5,3.7);c.lookAt(0,0,0);const m=food?createFood(id):createIngredient(id),d=m.userData.dimensions;m.scale.setScalar(1.8/Math.max(d.x,d.y,d.z));s.add(m);r.render(s,c);const url=r.domElement.toDataURL();r.dispose();r.forceContextLoss();thumbnails.set(key,url);return url;
}
function entryId(entry){return typeof entry==='string'?entry:entry.id;}
function entryMode(entry){return typeof entry==='string'?'split':entry.mode;}
function packAvailable(pack){return !liveAllowed||liveAllowed.has(pack.id);}
function appendRecipeChips(parent,pack,mode){
 const recipe=document.createElement('div');recipe.className='recipe-chips';recipe.setAttribute('aria-label','每份可装填的游戏食材');
 const portions=mode==='whole'?[['burgerbomb',1]]:Object.entries(pack.ingredients);
 for(const [id,count] of portions){const ingredient=ingredientById.get(id),chip=document.createElement('span');chip.className='recipe-chip';chip.dataset.food=id;
  chip.innerHTML=`<img src="${thumb(id)}" alt=""><span>${ingredient.name}</span><b>×${count}</b>`;recipe.append(chip);
 }
 parent.append(recipe);
}
function appendReferencePrice(parent,pack){
 if(!priceSnapshot)return;const item=priceSnapshot.products.find(p=>p.packId===pack.id),note=document.createElement('small');note.className='reference-price';
 if(Number.isFinite(item?.publicPriceYuan)){const label=document.createElement('span'),amount=document.createElement('b');label.textContent='门店参考';amount.textContent=`¥${item.publicPriceYuan.toFixed(2)}`;note.append(label,' ',amount);}
 else note.textContent=pack.id==='breakfast'?'游戏补给':'门店价格待核验';parent.append(note);
}
function preserveMenuPosition(list){
 const top=list.scrollTop,active=document.activeElement,button=list.contains(active)&&active.matches('button, summary')?active:null;
 const row=button?.closest('[data-pack], [data-shop-pack]');
 const rowSelector=row?(row.dataset.pack?`[data-pack="${row.dataset.pack}"]`:`[data-shop-pack="${row.dataset.shopPack}"]`):null;
 const key=button?.tagName==='SUMMARY'?'.pack-details > summary':button?.hasAttribute('data-delta')?`[data-delta="${button.dataset.delta}"]`:button?.hasAttribute('data-buy')?'[data-buy]':button?.hasAttribute('data-mode')?'.pack-mode, [data-mode]':null;
 const mode=button?.dataset.mode;
 return ()=>{list.scrollTop=top;if(!rowSelector||!key)return;const target=list.querySelector(rowSelector);const controls=[...target.querySelectorAll(key)];const next=controls.find(control=>control.classList.contains('pack-mode')||control.dataset.mode===mode)||controls[0];if(next&&!next.disabled)next.focus({preventScroll:true});};
}
function applyMenuSnapshot(snapshot){
 priceSnapshot=snapshot;const label=$('menuReference');label.hidden=!snapshot;
 if(snapshot){const stamp=snapshot.retrievedAt?new Date(snapshot.retrievedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'时间待核验';label.replaceChildren();
  for(const [className,text] of [['reference-source','参考门店'],['reference-store',snapshot.store?.name||'待选择'],['reference-time',stamp],['reference-game-note','金币为游戏定价']]){const part=document.createElement('span');part.className=className;part.textContent=text;label.append(part);}
 }
 renderPrep();if($('shopDialog').open)renderShop();
}
function renderPrep(){
 const restorePosition=preserveMenuPosition($('packList'));$('packList').replaceChildren();
 for(const pack of PACKS){const entries=selection.filter(e=>entryId(e)===pack.id),count=entries.length,mode=entries[0]?entryMode(entries[0]):'split';const row=document.createElement('div');row.className='pack-row'+(count?' is-picked':'')+(expandedPackId===pack.id?' is-expanded':'');row.dataset.pack=pack.id;
 row.innerHTML=`<img src="${thumb(pack.model,true)}" alt=""><div class="pack-copy"><strong>${pack.name}</strong></div><span class="pack-price">${pack.cost}</span><div class="quantity-control"><button type="button" data-delta="-1" aria-label="减少${pack.name}">−</button><output>${count}</output><button type="button" data-delta="1" aria-label="增加${pack.name}">+</button></div>`;
 const detail=document.createElement('details');detail.className='pack-details';detail.open=expandedPackId===pack.id;const summary=document.createElement('summary');summary.textContent=mode==='whole'?'食材 · 整堡':'食材 · 拆分';summary.addEventListener('click',event=>{event.preventDefault();expandedPackId=expandedPackId===pack.id?null:pack.id;renderPrep();});const copy=document.createElement('div');copy.className='pack-detail-body';detail.append(summary,copy);row.append(detail);appendRecipeChips(copy,pack,mode);appendReferencePrice(copy,pack);if(['bigmac','spicy','fish','breakfast'].includes(pack.id)){const b=document.createElement('button');b.className='pack-mode';b.type='button';b.dataset.mode=mode;b.textContent=mode==='whole'?'整堡炸弹 ⇄':'拆成食材 ⇄';b.setAttribute('aria-label',`${pack.name}，${mode==='whole'?'切换为拆食材':'保留整堡炸弹'}`);b.setAttribute('aria-pressed',String(mode==='whole'));b.disabled=!packAvailable(pack);b.addEventListener('click',()=>{const next=mode==='whole'?'split':'whole',candidate=count?selection.map(e=>entryId(e)===pack.id?{id:pack.id,mode:next}:e):[...selection,{id:pack.id,mode:next}];if(!buildInventory(candidate).ok){toast('金币不足');return;}selection=candidate;renderPrep();});copy.append(b);}
 for(const b of row.querySelectorAll('[data-delta]')){const delta=+b.dataset.delta;b.disabled=delta<0?!count:!packAvailable(pack)||!buildInventory([...selection,{id:pack.id,mode}]).ok;b.addEventListener('click',()=>{if(delta>0)selection.push({id:pack.id,mode});else{const i=selection.findIndex(e=>entryId(e)===pack.id);selection.splice(i,1);}renderPrep();});}
 if(!packAvailable(pack))row.classList.add('is-unavailable');$('packList').append(row);
 }
 restorePosition();
 const loadout=buildInventory(selection);$('supplyUsed').textContent=loadout.spent;$('startButton').disabled=!loadout.ok||!Object.values(loadout.inventory).some(Boolean);$('loadoutPreview').replaceChildren();
 for(const ingredient of INGREDIENTS){const n=loadout.inventory[ingredient.id]||0;if(!n)continue;const v=document.createElement('span');v.title=`${ingredient.name} ×${n}`;v.innerHTML=`<img src="${thumb(ingredient.id)}" alt="${ingredient.name}"><small>×${n}</small>`;$('loadoutPreview').append(v);}
 if(phase==='prep')guide.prepare();
}
function addNode(ingredient,x,y,z,size=1.1,rotation=0,options={}){
 const id='food-'+nodes.length,mesh=new THREE.Group(),food=ingredientMesh(ingredient,size*.92);mesh.add(food);
 if(options.foodRotation)food.rotation.set(...options.foodRotation);else if(['patty','onion'].includes(ingredient))food.rotation.x=Math.PI/2;
 mesh.position.set(x,y,z);mesh.rotation.z=rotation;mesh.traverse(m=>{if(m.isMesh){m.castShadow=true;m.receiveShadow=true;}});castle.add(mesh);
 const hitScale=options.hitScale||[size*.86,size*.88,size*.8];
 const proxy=new THREE.Mesh(new THREE.BoxGeometry(...hitScale),new THREE.MeshBasicMaterial({visible:false}));proxy.position.set(x,y,z);proxy.rotation.z=rotation;proxy.userData.nodeId=id;castle.add(proxy);
 const node={id,ingredient,x,y,z,hp:1,cornHp:CORN_HITS_TO_CLEAR,removed:false,mesh,proxy,size,baseRotation:rotation,setpiece:options.setpiece||null};nodes.push(node);return node;
}
function rebuildCastle(){
 buildingDamage?.dispose();castle.clear();nodes=[];decor=[];pendingBursts=[];victoryTime=0;victoryPresented=false;stageSeed=Math.floor(Math.random()*0xffffffff);
 const stage=buildRestaurantStage({castle,addNode,box,sign,seed:stageSeed});decor=stage.decor;setpieces=stage.setpieces.sort((a,b)=>['bucket','sauce','fries'].indexOf(a.id)-['bucket','sauce','fries'].indexOf(b.id)).map(piece=>({...piece,cleared:false}));
 structureParts=stage.structureParts;structureById=new Map(structureParts.map(part=>[part.id,part]));
 buildingDamage=createBuildingDamage({scene,parts:structureParts,reducedMotion:reduced,onImpact:buildingImpact});
 totalNodes=nodes.length;goal=Math.ceil(totalNodes*.66);removedCount=0;
}
function refreshChamber(){
 if(chamber)launcher.remove(chamber);chamber=ingredientMesh(selected,.86);
 chamber.position.copy(launcher.getObjectByName('launcher-chamber').position);chamber.position.y-=.22;chamber.visible=!!inventory[selected];launcher.add(chamber);loadProgress=reduced?1:0;
 const readout=$('weaponReadout');readout.classList.remove('is-loaded');void readout.offsetWidth;readout.classList.add('is-loaded');updateWeapon();
}
function updateWeapon(){
 const ingredient=ingredientById.get(selected),qty=inventory[selected]||0;
 $('weaponIcon').src=thumb(selected);$('weaponName').textContent=ingredient.name;$('weaponCount').textContent=qty?String(qty).padStart(2,'0'):'空仓';$('weaponReadout').classList.toggle('is-empty',!qty);
 $('weaponFireMode').textContent=selected==='corn'?'高速连射':'长按连发';
 displayContext.fillStyle='#111518';displayContext.fillRect(0,0,1024,512);
 displayContext.fillStyle=qty?'#ffbc0d':'#777';displayContext.fillRect(0,0,1024,86);
 displayContext.textAlign='left';displayContext.fillStyle='#111';displayContext.font='900 50px Arial, sans-serif';displayContext.fillText(selected==='corn'?'玉米连射 · 装填就绪':'装填就绪 · 长按连发',38,61,950);
 displayContext.fillStyle='#fff';displayContext.font='900 136px Arial, sans-serif';displayContext.fillText(ingredient.name,36,263,600);
 displayContext.textAlign='right';displayContext.fillStyle=qty?'#ffcf32':'#fc704f';displayContext.font='900 182px Arial';displayContext.fillText(String(qty).padStart(2,'0'),980,454,470);
 displayContext.textAlign='left';displayContext.fillStyle=ingredient.color;displayContext.fillRect(38,336,26,117);displayContext.fillStyle='#fff';displayContext.font='900 62px Arial, sans-serif';displayContext.fillText(selected==='corn'?'通用破甲':'食材连消',86,393,400);displayTexture.needsUpdate=true;
 if(chamber)chamber.visible=qty>0;
}
function renderBattle(){
 const goals=$('setpieceGoals');goals.replaceChildren();for(const piece of setpieces){const item=document.createElement('span');item.className='setpiece-goal';item.dataset.state=piece.cleared?'cleared':'active';const ammo={bucket:'鸡块',sauce:'番茄酱',fries:'薯条'}[piece.id];item.innerHTML=`<span class="icon">${piece.cleared?'✓':({bucket:'01',sauce:'02',fries:'03'}[piece.id])}</span><strong>${piece.label}</strong><small>${piece.cleared?'已引爆':ammo+'触发'}</small>`;goals.append(item);}
 $('streakBadge').hidden=streak<2;$('streakCount').textContent=streak;
 $('roundProgress').textContent=`${Math.min(removedCount,goal)} / ${goal}`;$('roundProgress').closest('.battle-mission').style.setProperty('--progress',`${Math.min(removedCount/goal,1)*100}%`);$('coinCount').textContent=economy.coins;
 const remaining=Object.values(inventory).reduce((a,b)=>a+b,0);$('shotsCount').textContent=remaining+' 发';$('ingredientBar').replaceChildren();
 $('ammoEmptyHint').hidden=remaining>0||phase!=='battle';
 $('shopButton').disabled=phase!=='battle';$('shopButton').setAttribute('aria-label',`补给商店，余额 ${economy.coins} 金币`);
 $('weaponReadout').hidden=phase==='prep';
 for(const ingredient of [...INGREDIENTS.filter(a=>a.id==='corn'),...INGREDIENTS.filter(a=>a.id!=='corn')]){if(!ownedAmmo.has(ingredient.id))continue;const qty=inventory[ingredient.id]||0,b=document.createElement('button');b.type='button';b.className='ingredient-button'+(ingredient.id===selected?' is-selected':'');b.dataset.ingredient=ingredient.id;b.disabled=!qty;b.setAttribute('aria-pressed',String(ingredient.id===selected));b.setAttribute('aria-label',`${ingredient.name}，剩余${qty}发`);b.innerHTML=`<img src="${thumb(ingredient.id)}" alt=""><strong>${ingredient.name}</strong><small>${qty}</small>`;b.addEventListener('click',()=>{if(phase!=='battle')return;cancelPointer();selected=ingredient.id;refreshChamber();renderBattle();guide.event('ammo-selected',{ammoId:selected});canvas.focus({preventScroll:true});});$('ingredientBar').append(b);}
 updateWeapon();guide.refresh({ammoId:selected,cornAvailable:(inventory.corn||0)>0});if(phase==='won')$('gameGuide').hidden=true;
}
function renderShop(){
 const restorePosition=preserveMenuPosition($('shopList'));$('shopBalance').textContent=economy.coins;$('cornRefillButton').disabled=phase!=='battle'||economy.coins<CORN_REFILL_COST;$('cornRefillNote').textContent=`现有 ${inventory.corn||0} 粒 · 8 粒击碎一块食材`; $('shopList').replaceChildren();
 for(const pack of PACKS){const mode=shopModes.get(pack.id)||'split',row=document.createElement('div');row.className='shop-row';row.dataset.shopPack=pack.id;
 row.innerHTML=`<img src="${thumb(pack.model,true)}" alt=""><div class="shop-copy"><strong>${pack.name}</strong></div>`;
 appendRecipeChips(row.querySelector('.shop-copy'),pack,mode);
 appendReferencePrice(row.querySelector('.shop-copy'),pack);
 if(['bigmac','spicy','fish','breakfast'].includes(pack.id)){const modes=document.createElement('div');modes.className='shop-modes';for(const [id,label] of [['split','拆成食材'],['whole','整堡炸弹']]){const option=document.createElement('button');option.className='shop-mode';option.type='button';option.textContent=label;option.dataset.mode=id;option.setAttribute('aria-pressed',String(mode===id));option.addEventListener('click',()=>{shopModes.set(pack.id,id);renderShop();});modes.append(option);}row.querySelector('.shop-copy').append(modes);}
 const buy=document.createElement('button');buy.type='button';buy.className='shop-buy';buy.dataset.buy=pack.id;const available=packAvailable(pack),short=Math.max(0,pack.cost-economy.coins);buy.disabled=!available||short>0||phase!=='battle';buy.innerHTML=!available?'目录未收录':short?`还差 <b>${short}</b> 金币`:`<b>${pack.cost}</b> 金币 · 补给`;buy.setAttribute('aria-label',`购买${pack.name}，${mode==='whole'?'整堡炸弹':'拆成食材'}，${pack.cost}金币`);buy.addEventListener('click',()=>buyPack(pack.id,mode));row.append(buy);
 if(purchaseReceipts.get(pack.id)>performance.now())row.classList.add('is-bought');$('shopList').append(row);
 }
 restorePosition();
}
function buyPack(id,mode){
 if(phase!=='battle')return;const result=purchasePack(economy,inventory,{id,mode,allowedPackIds:liveAllowed});
 if(!result.ok){$('shopMessage').textContent=result.error;$('shopMessage').className='is-error';return;}
 economy=result.state;inventory=result.inventory;for(const [key,n] of Object.entries(result.added))if(n>0)ownedAmmo.add(key);
 if(!inventory[selected])selected=INGREDIENTS.find(a=>inventory[a.id]>0).id;refreshChamber();renderBattle();purchaseReceipts.set(id,performance.now()+1600);renderShop();restockNotified=false;
 const count=Object.values(result.added).reduce((sum,n)=>sum+n,0);$('shopMessage').className='is-success';$('shopMessage').textContent=`已装填 ${count} 发 · 花费 ${result.spent} 金币 · 余额 ${economy.coins}`;sound('combo');
}
function refillCorn(){
 if(phase!=='battle')return;const result=purchaseCorn(economy,inventory);if(!result.ok){$('shopMessage').textContent=result.error;return;}
 economy=result.state;inventory=result.inventory;ownedAmmo.add('corn');selected='corn';refreshChamber();renderBattle();renderShop();restockNotified=false;
 $('shopMessage').className='is-success';$('shopMessage').textContent=`玉米 +${CORN_REFILL_AMOUNT} · 花费 ${CORN_REFILL_COST} 金币 · 现有 ${inventory.corn} 粒`;sound('combo');guide.event('ammo-selected',{ammoId:'corn'});
}
function openShop(){if(phase!=='battle')return;cancelPointer();$('shopMessage').className='';$('shopMessage').textContent='选择套餐，即刻装填。关闭商店继续射击。';renderShop();$('shopDialog').showModal();}
function closeShop(){if($('shopDialog').open)$('shopDialog').close();cancelPointer();if(phase==='battle'){canvas.focus({preventScroll:true});toast('补给就绪，继续射击');}}
function coinFeedback(amount,position){
 if(!amount)return;const start=project({x:position.x,y:position.y,z:position.z}),wallet=$('coinCount').getBoundingClientRect(),end={x:wallet.x+wallet.width/2,y:wallet.y+wallet.height/2};
 const popup=document.createElement('span');popup.className='coin-popup';popup.textContent=`+${amount} 金币`;popup.style.left=start.x+'px';popup.style.top=start.y+'px';$('coinFlyLayer').append(popup);setTimeout(()=>popup.remove(),1100);
 if(!reduced){for(let i=0;i<Math.min(6,Math.ceil(amount/3));i++){const coin=document.createElement('span');coin.className='coin-fly';coin.textContent='•';$('coinFlyLayer').append(coin);coin.style.left='0';coin.style.top='0';const anim=coin.animate([{transform:`translate(${start.x}px,${start.y}px) scale(1)`},{transform:`translate(${(start.x+end.x)/2+(i-2)*13}px,${Math.min(start.y,end.y)-35-i*5}px) scale(1.15)`,offset:.5},{transform:`translate(${end.x}px,${end.y}px) scale(.35)`,opacity:.1}],{duration:600+i*55,easing:'cubic-bezier(.2,.7,.3,1)',fill:'forwards'});anim.onfinish=()=>coin.remove();}}
 const group=$('coinCount').closest('.battle-wallet');group?.classList.add('is-gaining');setTimeout(()=>group?.classList.remove('is-gaining'),650);
}
function resetEffects(){cancelPointer();for(const p of projectiles)scene.remove(p.mesh);for(const d of debris)scene.remove(d.mesh);projectiles=[];debris=[];pendingBursts=[];fx.reset();combatFeedback.reset();flash.intensity=0;recoil=shake=hitPause=0;streak=bestStreak=misses=0;clearTimeout(hitFlashTimer);$('hitFlash').classList.remove('is-active');}
function start(){const loadout=payLoadout(createEconomy(),selection,{allowedPackIds:liveAllowed});if(!loadout.ok||!Object.values(loadout.inventory).some(Boolean))return;clearTimeout(resultTimer);activateAudio();resetEffects();rebuildCastle();economy=loadout.state;inventory={...loadout.inventory};ownedAmmo=new Set(Object.keys(inventory).filter(id=>inventory[id]>0));restockNotified=false;purchaseReceipts.clear();selected='corn';shots=comboCount=0;phase='battle';$('crosshair').hidden=false;$('prepScreen').hidden=true;$('battleHud').hidden=false;$('resultDialog').close();launcher.visible=true;refreshChamber();renderBattle();resize();canvas.focus({preventScroll:true});const tutorial=guide.start({ammoId:selected,cornAvailable:(inventory.corn||0)>0});if(tutorial.status!=='active')toast('长按连射 · 同类食材触发连消');}
function backToPrep(){phase='prep';pointer=null;$('shopDialog').close();$('weaponReadout').hidden=true;$('coinFlyLayer').replaceChildren();economy=createEconomy();clearTimeout(resultTimer);$('resultDialog').close();$('battleHud').hidden=true;$('prepScreen').hidden=false;launcher.visible=false;resetEffects();rebuildCastle();renderPrep();resize();}
function setAim(x,y){aimScreen.x=THREE.MathUtils.clamp(x,12,innerWidth-12);aimScreen.y=THREE.MathUtils.clamp(y,70,innerHeight-90);aim.set(aimScreen.x/innerWidth*2-1,1-aimScreen.y/innerHeight*2);$('crosshair').style.left=aimScreen.x+'px';$('crosshair').style.top=aimScreen.y+'px';$('aimLabel').style.left=aimScreen.x+'px';$('aimLabel').style.top=(aimScreen.y+30)+'px';}
function collisionMeshes(){return [...nodes.filter(n=>!n.removed).map(n=>n.proxy),...(buildingDamage?.targets||[])];}
function describeContact(hit){
 if(!hit)return null;
 const node=nodes.find(n=>n.id===hit.object.userData.nodeId),structure=structureById.get(hit.object.userData.structureId);
 const world=hit.object.matrixWorld.clone();
 if(hit.instanceId!==undefined&&hit.object.isInstancedMesh){const instance=new THREE.Matrix4();hit.object.getMatrixAt(hit.instanceId,instance);world.multiply(instance);}
 const normal=hit.face?.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(world))||new THREE.Vector3(0,0,1);
 return {node,structure,point:hit.point,normal};
}
function picked(){raycaster.setFromCamera(aim,camera);return describeContact(raycaster.intersectObjects(collisionMeshes(),false)[0]);}
function buildingImpact({point,damage,destroyed,label,cause}){
 if(cause!=='direct')return;
 const contact=new THREE.Vector3(point.x,point.y,point.z);
 combatFeedback.hit({position:contact,kind:'chip',color:destroyed?'#fff1be':'#ffd36b',count:1,streak:1});
 if(!reduced){shake=Math.max(shake,destroyed?.085:.018);hitPause=Math.max(hitPause,destroyed?.045:0);flash.position.copy(contact);flash.intensity=destroyed?12:damage>1?5:0;}
 $('crosshair').classList.remove('is-hit');void $('crosshair').offsetWidth;$('crosshair').classList.add('is-hit');
 if(destroyed){$('comboLabel').textContent=label+'，崩开！';$('comboLabel').classList.remove('pop');void $('comboLabel').offsetWidth;$('comboLabel').classList.add('pop');clearTimeout(comboTimer);comboTimer=setTimeout(()=>{$('comboLabel').textContent='';},1100);}
}

function shoot(continuous=false){
 if(phase!=='battle'||projectiles.length>=(selected==='corn'?12:2)||document.querySelector('dialog[open]'))return false;
 const consume=consumeShot(inventory,selected);if(!consume.ok)return false;clearTimeout(toastTimer);$('toast').textContent='';inventory=consume.inventory;
 const hit=picked(),ammo=selected,mesh=ingredientMesh(ammo,ammo==='burgerbomb'?.74:ammo==='corn'?.18:.45),origin=launcher.getObjectByName('launcher-muzzle').getWorldPosition(new THREE.Vector3());
 raycaster.setFromCamera(aim,camera);const destination=hit?.point||raycaster.ray.at(28,new THREE.Vector3()),convergence=raycaster.ray.at(Math.min(2,camera.position.distanceTo(destination)*.15),new THREE.Vector3()),launchDistance=origin.distanceTo(convergence),flightDistance=launchDistance+convergence.distanceTo(destination);mesh.position.copy(origin);scene.add(mesh);
 projectiles.push({mesh,ammo,origin,destination,convergence,launchRatio:launchDistance/flightDistance,age:0,duration:flightDistance/(ammo==='corn'?85:ammo==='burgerbomb'?23:ammo==='fry'?52:ammo==='ketchup'?32:42),targetId:hit?.node?.id,structureId:hit?.structure?.id,normal:hit?.normal,previous:origin.clone()});
 shots++;recoil=ammo==='burgerbomb'?.19:ammo==='corn'?.045:.12;activateAudio();combatFeedback.fire({position:origin,direction:destination.clone().sub(origin).normalize(),ammo});
 if(!inventory[selected]){cancelPointer();selected=INGREDIENTS.find(i=>inventory[i.id]>0)?.id||selected;refreshChamber();}
 renderBattle();guide.event('shot',{ammoId:ammo,continuous});return true;
}
function throwDebris(mesh,{position=null,strength=1,life=1.8}={}){
 const origin=position||new THREE.Vector3(0,2,0),away=mesh.position.clone().sub(origin);away.z=Math.abs(away.z)+.7;away.normalize();
 castle.remove(mesh);scene.add(mesh);debris.push({mesh,velocity:away.multiplyScalar(2.5*strength).add(new THREE.Vector3((Math.random()-.5)*4,3+Math.random()*4,1+Math.random()*3)),angular:new THREE.Vector3((Math.random()-.5)*9,(Math.random()-.5)*10,(Math.random()-.5)*8),life:life+Math.random()*.6,age:0,bounces:0,scale:mesh.scale.clone()});
}
function ejectNode(node,type,origin){
 fx.impact({position:[node.x,node.y,node.z],strength:type==='bomb'?1.15:.65,color:ingredientById.get(node.ingredient).color,kind:node.ingredient==='ketchup'?'slide':'heavy',foodModel:node.ingredient});
 throwDebris(node.mesh,{position:origin,strength:type==='bomb'?1.5:1,life:1.7});
}
function burstNode(node,type,delay=0,origin=null){
 if(node.removed)return;node.removed=true;node.proxy.visible=false;removedCount++;
 if(delay>0&&!reduced)pendingBursts.push({node,type,origin,delay});else ejectNode(node,type,origin);
}
function hitCaption(outcome){
 if(outcome.setpieceIds?.length)return outcome.setpieceIds.length>1?'连环引爆！':`${setpieces.find(p=>p.id===outcome.setpieceIds[0])?.label}！`;
 return outcome.label+(outcome.type!=='match'&&outcome.removeIds.length>1?' ×'+outcome.removeIds.length:'');
}
function impactFeedback(point,kind,color,count=0){
 flash.position.copy(point).add(new THREE.Vector3(0,.5,1));flash.intensity=reduced?0:kind==='bomb'?24:kind==='combo'?19:11;
 shake=reduced?0:kind==='bomb'?.14:kind==='combo'?.09:kind==='miss'?.025:.055;
 if(!reduced&&kind!=='miss')hitPause=kind==='bomb'?.095:kind==='combo'?.07:.035;
 combatFeedback.hit({position:point,kind,color,count,streak});
 const overlay=$('hitFlash');overlay.dataset.kind=kind;overlay.classList.remove('is-active');void overlay.offsetWidth;if(!reduced&&kind!=='miss')overlay.classList.add('is-active');clearTimeout(hitFlashTimer);hitFlashTimer=setTimeout(()=>overlay.classList.remove('is-active'),240);
}
function collision(projectile,point,target,structureHit=null){
 if(structureHit){buildingDamage.hit({partId:structureHit.structure.id,ammo:projectile.ammo,point,normal:structureHit.normal||projectile.normal});return;}
 const color=ingredientById.get(projectile.ammo).color;
 if(!target||target.removed){streak=0;misses++;impactFeedback(point,'miss',color);toast('擦边了，瞄准食材再来');renderBattle();return;}
 const outcome=resolveStageHit({ammo:projectile.ammo,target,neighbors:nodes,setpieces});
 for(const damage of outcome.damage){const node=nodes.find(n=>n.id===damage.id);if(node)node.cornHp=damage.remaining;}
 if(outcome.type==='chip'&&!outcome.removeIds.length){target.wobble=.16;combatFeedback.hit({position:point,kind:'chip',color:'#ffcf32',count:1,streak:1});$('crosshair').classList.remove('is-hit');void $('crosshair').offsetWidth;$('crosshair').classList.add('is-hit');guide.event('damage',{ammoId:projectile.ammo,kind:'chip'});return;}
 if(outcome.removeIds.length){
  guide.event('cleared',{ammoId:projectile.ammo,kind:outcome.type});if(outcome.setpieceIds.length)guide.event('setpiece',{ammoId:projectile.ammo});
  streak++;bestStreak=Math.max(bestStreak,streak);
  const kind=outcome.setpieceIds.length||outcome.type==='bomb'?'bomb':outcome.type==='combo'?'combo':'match';
  const reward=earnCoins(economy,outcome.removeIds,{combo:outcome.type==='combo'});economy=reward.state;coinFeedback(reward.earned,point);impactFeedback(point,kind,color,outcome.removeIds.length);
  $('crosshair').classList.remove('is-hit');void $('crosshair').offsetWidth;$('crosshair').classList.add('is-hit');
  outcome.removeIds.forEach((id,index)=>{const node=nodes.find(n=>n.id===id);if(node)burstNode(node,outcome.type,kind==='bomb'?index*.032:index*.018,point);});
  for(const id of outcome.setpieceIds){const piece=setpieces.find(p=>p.id===id);piece.cleared=true;for(const mesh of piece.decor||[])if(mesh.parent===castle)throwDebris(mesh,{position:new THREE.Vector3(...piece.position),strength:1.3,life:2.1});buildingDamage.collapseZone({bucket:'left-wing',sauce:'loft',fries:'right-wing'}[id]);if(id==='sauce')buildingDamage.collapseZone('marquee');}
  if(outcome.type==='combo'||outcome.type==='bomb'){comboCount++;fx.ability({kind:'burst',position:point.toArray(),color,ammoId:projectile.ammo});}
  $('comboLabel').textContent=hitCaption(outcome);$('comboLabel').classList.remove('pop');void $('comboLabel').offsetWidth;$('comboLabel').classList.add('pop');clearTimeout(comboTimer);comboTimer=setTimeout(()=>$('comboLabel').textContent='',1250);
 }else{streak=0;misses++;impactFeedback(point,'miss',color);target.wobble=.38;toast(`换${ingredientById.get(target.ingredient).name}，或试试配方组合`);}
 renderBattle();
 if(isStageComplete(removedCount,goal,setpieces)&&phase==='battle'){
  phase='won';cancelPointer();$('crosshair').hidden=true;setAim(innerWidth/2,innerHeight*.45);$('aimLabel').textContent='餐厅正在坍塌！';$('gameGuide').hidden=true;const finishReward=earnCoins(economy,nodes.filter(n=>!n.removed).map(n=>n.id));economy=finishReward.state;if(finishReward.earned)coinFeedback(finishReward.earned,new THREE.Vector3(0,4,1));
  let index=0;for(const node of nodes)if(!node.removed)burstNode(node,'bomb',index++*.035,new THREE.Vector3(0,3,0));
  buildingDamage.collapseAll();victoryTime=0;victoryPresented=false;
  for(const mesh of decor)if(!mesh.userData.structureId&&mesh.parent===castle)throwDebris(mesh,{strength:1.7,life:2.4});
  impactFeedback(new THREE.Vector3(0,4,1),'bomb','#ffbc0d',totalNodes);renderBattle();
 }
}
function showResult(won){$('resultTitle').textContent=won?'KFB 餐厅，开花了！':'再配一餐！';$('resultDetail').textContent=won?`三处机关全部引爆 · 最高 ${bestStreak} 连击 · ${misses===0?'一发也没浪费！':'再试试更少失误通关。'}`:'弹药用完了。对照机关需要的食材，换一份配置再来。';$('resultStats').innerHTML=`<div><strong>${economy.earned}</strong><span>金币入账</span></div><div><strong>${shots}</strong><span>发食材</span></div><div><strong>${comboCount}</strong><span>次组合爆破</span></div><div><strong>${removedCount}</strong><span>块食材清除</span></div>`;$('resultDialog').showModal();}
canvas.addEventListener('pointerdown',e=>{if(phase!=='battle'||e.button!==0||pointer)return;cancelPointer();canvas.focus({preventScroll:true});pointer={id:e.pointerId};setAim(e.clientX,e.clientY);canvas.setPointerCapture(e.pointerId);holdFire.begin(performance.now());$('crosshair').classList.add('aiming');});
canvas.addEventListener('pointermove',e=>{if(phase!=='battle')return;if(e.pointerType==='mouse'||pointer?.id===e.pointerId)setAim(e.clientX,e.clientY);});
canvas.addEventListener('pointerup',e=>{if(pointer?.id!==e.pointerId)return;const tap=holdFire.release();pointer=null;$('crosshair').classList.remove('aiming');if(tap)shoot(false);});
function cancelPointer(){pointer=null;spaceFiring=false;holdFire.cancel();$('crosshair').classList.remove('aiming');}
canvas.addEventListener('pointercancel',cancelPointer);canvas.addEventListener('lostpointercapture',cancelPointer);addEventListener('blur',cancelPointer);document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelPointer();});
$('cornRefillButton').addEventListener('click',refillCorn);
$('guideReplayButton').addEventListener('click',()=>{$('helpDialog').close();if(phase==='battle')guide.start({force:true,ammoId:selected,cornAvailable:(inventory.corn||0)>0});else guide.prepare({force:true});});
$('shopButton').addEventListener('click',openShop);$('shopClose').addEventListener('click',closeShop);$('shopContinue').addEventListener('click',closeShop);$('shopDialog').addEventListener('close',cancelPointer);
$('startButton').addEventListener('click',start);$('backToPrep').addEventListener('click',backToPrep);$('retryButton').addEventListener('click',backToPrep);$('helpButton').addEventListener('click',()=>{cancelPointer();$('helpDialog').showModal();});$('dataButton').addEventListener('click',()=>$('dataDialog').showModal());$('soundButton').addEventListener('click',()=>{soundEnabled=!soundEnabled;activateAudio();$('soundButton').setAttribute('aria-pressed',String(soundEnabled));});for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>b.closest('dialog').close());
$('shareButton').addEventListener('click',async()=>{const text=`《吃我一发麦麦》战报：${shots}发食材，${comboCount}次组合，清掉${removedCount}块 KFB 食物建筑，最高${bestStreak}连击！`;try{await navigator.clipboard.writeText(text);$('shareButton').textContent='已复制';}catch{toast(text);}});
addEventListener('keydown',e=>{
 const control=document.activeElement?.closest('button,a[href],summary,input,select,textarea,[contenteditable]:not([contenteditable="false"])');
 if(e.altKey||e.ctrlKey||e.metaKey)return;
 if(e.code==='KeyB'&&!e.repeat&&!document.activeElement?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')){if($('shopDialog').open)closeShop();else if(!document.querySelector('dialog[open]'))openShop();return;}
 if(control||document.querySelector('dialog[open]'))return;
 if(e.code==='Space'&&phase==='battle'){e.preventDefault();if(!e.repeat){cancelPointer();spaceFiring=true;holdFire.begin(performance.now(),{immediate:true});holdFire.tick(performance.now(),fireInterval(selected),()=>shoot(false));}}
 if(/^Digit[1-9]$/.test(e.code)){const a=INGREDIENTS[+e.code.slice(-1)-1];if(a&&inventory[a.id]){cancelPointer();selected=a.id;refreshChamber();renderBattle();guide.event('ammo-selected',{ammoId:selected});}}
});
addEventListener('keyup',e=>{if(e.code==='Space'&&spaceFiring){e.preventDefault();cancelPointer();}});
function resize(){cancelPointer();syncRendererResolution(renderer,{width:innerWidth,height:innerHeight,dpr:devicePixelRatio});camera.aspect=innerWidth/innerHeight;const portrait=innerHeight>innerWidth;camera.fov=portrait?54:48;camera.position.set(portrait?.35:1.25,portrait?5.1:5.5,portrait?Math.max(22,13.7/(2*Math.tan(THREE.MathUtils.degToRad(27))*camera.aspect)):15.6);camera.lookAt(0,!portrait&&innerHeight<500?3.3:3.7,.3);camera.updateProjectionMatrix();camera.updateMatrixWorld();launcher.position.set(0,0,-1.4);launcher.scale.setScalar(portrait?.21:.26);launcher.updateMatrixWorld(true);
 const screenLocal=camera.worldToLocal(gunDisplay.getWorldPosition(new THREE.Vector3())),halfHeight=-screenLocal.z*Math.tan(THREE.MathUtils.degToRad(camera.fov/2));
 const trayHeight=document.querySelector('.combat-loadout').getBoundingClientRect().height;
 const screenY=portrait?Math.min(.77,(innerHeight-Math.max(136,trayHeight)-58)/innerHeight):.86;
 launcher.position.x=(portrait?.56:.7)*halfHeight*camera.aspect-screenLocal.x;
 launcher.position.y=(1-2*screenY)*halfHeight-screenLocal.y;
 setAim(innerWidth/2,innerHeight*.45);}
addEventListener('resize',resize);watchDisplayDensity(resize);
function project(node){const p=new THREE.Vector3(node.x,node.y,node.z).project(camera);return {x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2};}
function visibleBuildingTargets(){
 const probe=new THREE.Raycaster(),meshes=collisionMeshes(),samples=[[.5,.5],[.22,.5],[.78,.5],[.5,.25],[.5,.75],[.22,.25],[.78,.75]],result=[];
 for(const mesh of buildingDamage.targets){const id=mesh.userData.structureId,part=structureById.get(id),bounds=new THREE.Box3().setFromObject(mesh);if(!part||bounds.isEmpty())continue;
  for(const [rx,ry] of samples){const point=new THREE.Vector3(THREE.MathUtils.lerp(bounds.min.x,bounds.max.x,rx),THREE.MathUtils.lerp(bounds.min.y,bounds.max.y,ry),bounds.max.z+.005);probe.set(camera.position,point.clone().sub(camera.position).normalize());const hit=probe.intersectObjects(meshes,false)[0];if(hit?.object.userData.structureId!==id)continue;const projected=project(hit.point);result.push({id,partId:id,zone:part.zone,label:part.label,...projected});break;}
 }
 return result;
}
function animate(now){let dt=Math.min((now-last)/1000,.045);last=now;const paused=!!document.querySelector('dialog[open]')||document.hidden;if(paused){dt=0;if(holdFire.active||pointer)cancelPointer();}if(phase==='battle'&&!paused)holdFire.tick(now,fireInterval(selected),()=>shoot(true));else if(holdFire.active)cancelPointer();if(hitPause>0){hitPause-=dt;dt*=.2;}
 for(const item of [...pendingBursts]){item.delay-=dt;if(item.delay<=0){ejectNode(item.node,item.type,item.origin);pendingBursts.splice(pendingBursts.indexOf(item),1);}}
 for(const piece of setpieces)if(piece.ring&&!piece.cleared){piece.ring.scale.setScalar(reduced?1:1+Math.sin(now*.004)*.035);}
 for(const p of [...projectiles]){p.age+=dt;const t=Math.min(1,p.age/p.duration);if(t<p.launchRatio)p.mesh.position.lerpVectors(p.origin,p.convergence,t/p.launchRatio);else p.mesh.position.lerpVectors(p.convergence,p.destination,(t-p.launchRatio)/(1-p.launchRatio));p.mesh.rotation.x+=dt*8;p.mesh.rotation.z+=dt*5;
 const delta=p.mesh.position.clone().sub(p.previous),distance=delta.length();let contact=null;if(distance>0){raycaster.set(p.previous,delta.normalize());raycaster.far=distance+.15;contact=raycaster.intersectObjects(collisionMeshes(),false)[0];raycaster.far=Infinity;}
 if(contact||t>=1){const hit=describeContact(contact),target=hit?.node||(!hit?nodes.find(n=>n.id===p.targetId&&!n.removed):null),structureHit=hit?.structure?hit:!hit&&p.structureId?{structure:structureById.get(p.structureId),normal:p.normal}:null;collision(p,contact?.point||p.destination,target,structureHit?.structure?structureHit:null);scene.remove(p.mesh);projectiles.splice(projectiles.indexOf(p),1);}else p.previous.copy(p.mesh.position);}
 for(const d of [...debris]){d.age+=dt;d.velocity.y-=12*dt;d.mesh.position.addScaledVector(d.velocity,dt);if(d.mesh.position.y<.32&&d.velocity.y<0&&d.bounces<2){d.mesh.position.y=.32;d.velocity.y*=-.38;d.velocity.x*=.7;d.velocity.z*=.7;d.bounces++;}d.mesh.rotation.x+=d.angular.x*dt;d.mesh.rotation.y+=d.angular.y*dt;d.mesh.rotation.z+=d.angular.z*dt;const k=Math.max(0,1-(d.age/d.life)**3);d.mesh.scale.copy(d.scale).multiplyScalar(k);if(d.age>=d.life){scene.remove(d.mesh);debris.splice(debris.indexOf(d),1);}}
 for(const n of nodes)if(n.wobble>0){n.wobble-=dt;n.mesh.position.z=n.z+Math.sin(n.wobble*40)*n.wobble*.3;}
 if(phase==='battle'&&!projectiles.length&&!Object.values(inventory).some(Boolean)){if(canRestock(economy,liveAllowed)){if(!restockNotified){restockNotified=true;toast('弹药用完了，去补给商店装填');renderBattle();}}else{phase='lost';renderBattle();resultTimer=setTimeout(()=>showResult(false),700);}}
 loadProgress=Math.min(1,loadProgress+dt*4);if(chamber){chamber.position.y=launcher.getObjectByName('launcher-chamber').position.y-.22+(reduced?0:(1-loadProgress)**2*.4);chamber.rotation.z=reduced?0:Math.sin(loadProgress*Math.PI)*-.15;}
 recoil=Math.max(0,recoil-dt*.5);launcher.position.z=-1.4+recoil;launcher.rotation.y=-.08-aim.x*.16;launcher.rotation.x=aim.y*.1+recoil*.7;flash.intensity=Math.max(0,flash.intensity-dt*55);fx.update(dt);combatFeedback.update(dt);buildingDamage?.update(dt);
 if(phase==='won'&&!victoryPresented){victoryTime+=dt;const building=buildingDamage.state;if(victoryTime>=2.6&&!pendingBursts.length&&building.parts.every(part=>part.status==='rubble')){victoryPresented=true;$('aimLabel').textContent='拆平了！重配再来';showResult(true);}}

 if(phase==='battle'){
  const hit=picked(),outcome=hit?.node?resolveStageHit({ammo:selected,target:hit.node,neighbors:nodes,setpieces}):null;
  const valid=!!hit?.structure||!!outcome?.removeIds.length||outcome?.type==='chip';$('crosshair').classList.toggle('can-match',valid);
  if(hit?.structure){const part=buildingDamage.state.parts.find(part=>part.id===hit.structure.id);$('aimLabel').textContent=`${hit.structure.label} · ${part.hp}/${part.maxHp} · 持续射击拆除`;}
  else $('aimLabel').textContent=hit?.node?`${ingredientById.get(hit.node.ingredient).name} · ${selected==='corn'?'还需 '+hit.node.cornHp+' 粒':valid?hitCaption(outcome):'换弹试试'}`:'点射 / 长按连发';
 }
 const cameraBase=camera.position.clone();if(shake>0&&!reduced){camera.position.x+=Math.sin(now*.075)*shake;camera.position.y+=Math.cos(now*.09)*shake;camera.updateMatrixWorld();}renderer.render(scene,camera);camera.position.copy(cameraBase);camera.updateMatrixWorld();shake=Math.max(0,shake-dt*.7);requestAnimationFrame(animate);}
rebuildCastle();renderPrep();for(const [id,model] of [['heroBurger','bigmac'],['heroFries','fries'],['heroNuggets','nuggets']]){if($(id))$(id).src=thumb(model,true,384);}launcher.visible=false;resize();$('loading').remove();requestAnimationFrame(animate);
window.__burgerGame={get state(){return {phase,selected,inventory:{...inventory},shots,removed:removedCount,goal,total:totalNodes,combos:comboCount,projectiles:projectiles.length,pendingBursts:pendingBursts.length,streak,bestStreak,misses,stageSeed,holding:holdFire.active,guide:guide.state,objectives:setpieces.filter(p=>p.cleared).length,coins:economy.coins,earned:economy.earned,spent:economy.spent,shopOpen:$('shopDialog').open,source:liveAllowed?'official-nutrition-catalog':'demo-game-conversion'};},get targets(){const visible=nodes.filter(n=>!n.removed),probe=new THREE.Raycaster();return visible.filter(n=>{probe.set(camera.position,new THREE.Vector3(n.x,n.y,n.z).sub(camera.position).normalize());return probe.intersectObjects(collisionMeshes(),false)[0]?.object.userData.nodeId===n.id;}).map(n=>({id:n.id,ingredient:n.ingredient,...project(n)}));},get building(){return buildingDamage.state;},get buildingTargets(){return visibleBuildingTargets();},get nodes(){return nodes.map(({id,ingredient,x,y,z,removed,setpiece,cornHp})=>({id,ingredient,x,y,z,removed,setpiece,cornHp}));},get setpieces(){return setpieces.map(({id,label,triggerIds,memberIds,cleared})=>({id,label,triggerIds,memberIds,cleared}));},get gunDisplayBounds(){const points=gunDisplay.geometry.attributes.position,bounds=new THREE.Box2();gunDisplay.updateWorldMatrix(true,false);for(let i=0;i<points.count;i++){const p=new THREE.Vector3().fromBufferAttribute(points,i).applyMatrix4(gunDisplay.matrixWorld).project(camera);bounds.expandByPoint(new THREE.Vector2((p.x+1)*innerWidth/2,(1-p.y)*innerHeight/2));}return {x:bounds.min.x,y:bounds.min.y,width:bounds.max.x-bounds.min.x,height:bounds.max.y-bounds.min.y};},get sceneStats(){return {drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,fx:fx.stats,combat:combatFeedback.stats};},get selection(){return [...selection];},applyLiveCatalog(info){liveAllowed=new Set(info.map(x=>x.id));selection=selection.filter(e=>liveAllowed.has(entryId(e)));backToPrep();},clearLiveCatalog(){liveAllowed=null;backToPrep();}};
setupMcpUI({onLive:info=>window.__burgerGame.applyLiveCatalog(info),onDemo:()=>window.__burgerGame.clearLiveCatalog(),onMenu:applyMenuSnapshot,getSelection:()=>selection});
