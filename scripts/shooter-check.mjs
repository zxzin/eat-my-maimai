import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildInventory,resolveHit} from '../src/ingredient-rules.js';

const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
const errors=[],reports=[];
await fs.mkdir('artifacts',{recursive:true});
const sourceFiles=['index.html','src/style.css','src/main.js','src/ingredient-models.js','src/ingredient-rules.js','src/food-models.js','src/impact-fx.js'];
async function sourceHashes(){return Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await fs.readFile(file)).digest('hex')])));}
const sourcesBefore=await sourceHashes();

async function ready(page){
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:5178',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.__burgerGame?.state.phase==='prep',null,{timeout:15000});
  await page.locator('#loading').waitFor({state:'detached'});
}
async function state(page){return page.evaluate(()=>window.__burgerGame.state);}
async function visibleTargets(page){
  return page.evaluate(()=>window.__burgerGame.targets.filter(target=>
    target.x>=14&&target.x<=innerWidth-14&&target.y>=72&&target.y<=innerHeight-92
    &&document.elementFromPoint(target.x,target.y)?.id==='gameCanvas'));
}
async function candidates(page){
  const [snapshot,nodes,targets]=await Promise.all([
    state(page),page.evaluate(()=>window.__burgerGame.nodes),visibleTargets(page),
  ]);
  const choices=[];
  for(const [ammo,count] of Object.entries(snapshot.inventory)){
    if(!count)continue;
    for(const projected of targets){
      const target=nodes.find(node=>node.id===projected.id),outcome=resolveHit({ammo,target,neighbors:nodes});
      choices.push({ammo,target:projected,outcome});
    }
  }
  return choices.sort((a,b)=>b.outcome.removeIds.length-a.outcome.removeIds.length);
}
async function choose(page,ammo,touch=false){
  const button=page.locator(`[data-ingredient="${ammo}"]`);
  await button.scrollIntoViewIfNeeded();
  if(touch)await button.tap();else await button.click();
  assert.equal((await state(page)).selected,ammo,'visible ammunition control selects the requested ingredient');
}
async function shoot(page,choice,{touch=false,cdp,screenshot}={}){
  await choose(page,choice.ammo,touch);
  // Coordinates are freshly projected after UI interaction, never a state edit.
  const target=(await visibleTargets(page)).find(candidate=>candidate.id===choice.target.id);
  assert.ok(target,'selected target remains visible outside the HUD');
  const before=await state(page);
  if(touch){
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:target.x,y:target.y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }else await page.mouse.click(target.x,target.y);
  const fired=await state(page);
  assert.equal(fired.shots,before.shots+1,'one pointer release fires exactly one projectile');
  assert.equal(fired.inventory[choice.ammo],before.inventory[choice.ammo]-1,'one shot consumes exactly one ingredient');
  for(const [id,qty] of Object.entries(before.inventory))if(id!==choice.ammo)assert.equal(fired.inventory[id],qty,'other ammunition quantities stay unchanged');
  await page.waitForFunction(()=>window.__burgerGame.state.projectiles===0,null,{timeout:10000});
  const after=await state(page);
  if(screenshot)await page.screenshot({path:`artifacts/${screenshot}`});
  return {ammo:choice.ammo,targetId:target.id,targetIngredient:target.ingredient,predictedType:choice.outcome.type,shots:after.shots,removed:after.removed-before.removed,phase:after.phase};
}
async function prepChecks(page){
  const selection=await page.evaluate(()=>window.__burgerGame.selection);
  assert.equal(buildInventory(selection).spent,56);
  assert.equal(await page.locator('#supplyUsed').textContent(),'56');
  assert.equal(await page.locator('[data-delta="1"]:enabled').count(),0,'remaining four points cannot buy another pack');
  await page.getByRole('button',{name:'早餐补给，保留整堡炸弹'}).click();
  assert.deepEqual(await page.evaluate(()=>window.__burgerGame.selection),selection,'an unaffordable whole-burger selection preserves the prepared loadout');
  const fries=()=>page.locator('[data-pack="fries"]');
  await fries().locator('[data-delta="-1"]').click();
  assert.equal(await page.locator('#supplyUsed').textContent(),'46');
  assert.equal(await fries().locator('output').textContent(),'0');
  await fries().locator('[data-delta="1"]').click();
  assert.equal(await page.locator('#supplyUsed').textContent(),'56');
  assert.equal(await fries().locator('output').textContent(),'1');

  const spicy=()=>page.locator('[data-pack="spicy"]');
  assert.match(await spicy().locator('.pack-copy span').textContent(),/整堡/);
  await spicy().getByRole('button',{name:'麦辣鸡腿汉堡，切换为拆食材'}).click();
  let loadout=buildInventory(await page.evaluate(()=>window.__burgerGame.selection));
  assert.equal(loadout.spent,56);assert.equal(loadout.inventory.burgerbomb,0);assert.equal(loadout.inventory.bun,4);
  assert.equal(await page.locator('#loadoutPreview [title="汉堡炸弹 ×1"]').count(),0);
  await spicy().getByRole('button',{name:'麦辣鸡腿汉堡，保留整堡炸弹'}).click();
  loadout=buildInventory(await page.evaluate(()=>window.__burgerGame.selection));
  assert.equal(loadout.spent,56);assert.equal(loadout.inventory.burgerbomb,1);assert.equal(loadout.inventory.bun,2);
  assert.equal(await page.locator('#loadoutPreview [title="汉堡炸弹 ×1"]').count(),1);
  return loadout;
}
async function begin(page,touch=false){
  const expected=buildInventory(await page.evaluate(()=>window.__burgerGame.selection));
  if(touch)await page.locator('#startButton').tap();else await page.locator('#startButton').click();
  await page.waitForFunction(()=>window.__burgerGame.state.phase==='battle');
  assert.deepEqual((await state(page)).inventory,expected.inventory,'battle receives exactly the prepared resources');
  assert.equal(await page.locator('#prepScreen').isVisible(),false);
  assert.equal(await page.locator('#battleHud').isVisible(),true);
}
async function wrongThenMatch(page,options={}){
  const wrong=(await candidates(page)).find(choice=>choice.ammo==='onion'&&choice.outcome.type==='impact');
  assert.ok(wrong,'a visible target can demonstrate a genuine mismatched ingredient');
  const wrongResult=await shoot(page,wrong,options);
  assert.equal(wrongResult.removed,0,'a mismatched shot leaves the structure intact');
  const matching=(await candidates(page)).find(choice=>choice.outcome.type==='match'&&choice.outcome.removeIds.length>=2);
  assert.ok(matching,'a visible contiguous same-ingredient cluster is available');
  const matchResult=await shoot(page,matching,{...options,screenshot:options.matchScreenshot});
  assert.ok(matchResult.removed>=2,'matching ammunition clears a real ingredient cluster');
  return {wrongResult,matchResult};
}

try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});await ready(page);
  await prepChecks(page);await page.screenshot({path:'artifacts/shooter-desktop-prep.png'});
  await begin(page);await page.screenshot({path:'artifacts/shooter-desktop-ready.png'});
  const demonstration=await wrongThenMatch(page,{matchScreenshot:'shooter-desktop-match.png'}),shots=[demonstration.wrongResult,demonstration.matchResult];
  const combination=(await candidates(page)).find(choice=>choice.outcome.type==='combo'&&choice.outcome.removeIds.length>=2);
  assert.ok(combination,'a recipe combination is available');
  const combined=await shoot(page,combination,{screenshot:'shooter-desktop-combo.png'});shots.push(combined);
  assert.ok(combined.removed>=2,'the recipe combination clears multiple blocks');
  assert.ok((await state(page)).combos>=1,'combination feedback is counted');
  const bomb=(await candidates(page)).find(choice=>choice.ammo==='burgerbomb');
  assert.ok(bomb);const bombResult=await shoot(page,bomb,{screenshot:'shooter-desktop-bomb.png'});shots.push(bombResult);
  assert.ok(bombResult.removed>=2,'the purchased whole burger creates a local blast');
  for(let i=0;i<24&&(await state(page)).phase==='battle';i++){
    const best=(await candidates(page)).find(choice=>choice.outcome.removeIds.length>0);
    assert.ok(best,'remaining resources can clear another visible ingredient');
    shots.push(await shoot(page,best));
  }
  const victory=await state(page);assert.equal(victory.phase,'won','legal UI shots can win the default preparation');
  assert.ok(victory.earned>=victory.total*3,'every visually destroyed block earns its base reward, including the victory cascade');
  assert.equal(victory.coins,60+victory.earned-victory.spent,'the final wallet reconciles all preparation costs and elimination rewards');
  await page.locator('#resultDialog[open]').waitFor();await page.screenshot({path:'artifacts/shooter-desktop-victory.png'});
  reports.push({device:'desktop mouse',demonstration,shots,victory});

  for(const [width,height] of [[390,844],[844,390],[360,640]]){
    const context=await browser.newContext({viewport:{width,height},isMobile:true,hasTouch:true,deviceScaleFactor:1});
    const p=await context.newPage();await ready(p);
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}×${height} preparation has no horizontal page overflow`);
    await p.screenshot({path:`artifacts/shooter-mobile-prep-${width}x${height}.png`});
    await begin(p,true);await p.screenshot({path:`artifacts/shooter-mobile-ready-${width}x${height}.png`});
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'battle has no horizontal page overflow');
    const bar=await p.locator('#ingredientBar').boundingBox();
    assert.ok(bar.x>=0&&bar.x+bar.width<=width+.5&&bar.y>=0&&bar.y+bar.height<=height+.5,'ammunition tray stays in the viewport');
    assert.ok((await visibleTargets(p)).length>=12,'a useful part of the enemy food wall is visible and touchable');
    const cdp=await context.newCDPSession(p);
    const mobileDemo=await wrongThenMatch(p,{touch:true,cdp,matchScreenshot:`shooter-mobile-match-${width}x${height}.png`});
    const wholeBurger=(await candidates(p)).find(choice=>choice.ammo==='burgerbomb');
    assert.ok(wholeBurger,'the paid whole burger is available on mobile');
    const mobileBomb=await shoot(p,wholeBurger,{touch:true,cdp,screenshot:`shooter-mobile-bomb-${width}x${height}.png`});
    assert.ok(mobileBomb.removed>=2,'the last ammunition control scrolls into view and releases its bomb');
    reports.push({device:`touch ${width}x${height}`,...mobileDemo,mobileBomb,state:await state(p)});
    await context.close();
  }

  assert.deepEqual(errors,[]);
  const sourcesAfter=await sourceHashes();
  assert.deepEqual(sourcesAfter,sourcesBefore,'sources remain unchanged throughout browser verification');
  const receipt={checkedAt:new Date().toISOString(),sourceHashes:sourcesAfter,errors,reports,notes:'All shots use actual mouse/touch input on projected visible targets. Pure rules choose legal aiming candidates without editing game state. Mobile checks use Chromium touch emulation, not a physical handset.'};
  await fs.writeFile('artifacts/shooter-browser-receipt.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{await browser.close();}
