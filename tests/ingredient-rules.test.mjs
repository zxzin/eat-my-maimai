import test from 'node:test';
import assert from 'node:assert/strict';
import {INGREDIENTS,PACKS,PREP_BUDGET,DEFAULT_PACK_IDS,WHOLE_BURGER_PACK_IDS,MATCH_RULES,CORN_HITS_TO_CLEAR,buildInventory,initialLoadout,consumeShot,resolveHit} from '../src/ingredient-rules.js';

const block=(id,ingredient,x=0,y=0,z=0,extra={})=>({id,ingredient,x,y,z,hp:1,...extra});

test('default preparation purchases finite authored ingredients within the budget',()=>{
  const loadout=initialLoadout();
  assert.equal(loadout.ok,true);assert.equal(loadout.spent,56);assert.equal(loadout.remaining,PREP_BUDGET-56);
  assert.deepEqual(loadout.selectedPackIds,DEFAULT_PACK_IDS.map(entry=>typeof entry==='string'?entry:entry.id));
  assert.deepEqual(loadout.selectedPacks,[{id:'bigmac',mode:'split'},{id:'fries',mode:'split'},{id:'nuggets',mode:'split'},{id:'spicy',mode:'whole'}]);
  assert.deepEqual(loadout.inventory,{bun:2,ketchup:3,patty:2,onion:1,sausage:0,fry:6,nugget:5,burgerbomb:1,corn:0});
  for(const pack of PACKS)for(const [id,count] of Object.entries(pack.ingredients)){
    assert.ok(INGREDIENTS.some(ingredient=>ingredient.id===id));
    assert.ok(Number.isSafeInteger(count)&&count>0);
  }
});

test('duplicate and diverse split packs provide only their paid ingredient portions',()=>{
  const loadout=buildInventory(['nuggets','nuggets','fries']);
  assert.equal(loadout.spent,34);assert.equal(loadout.inventory.nugget,10);
  assert.equal(loadout.inventory.fry,6);assert.equal(loadout.inventory.burgerbomb,0);
  const diverse=buildInventory(['nuggets','nuggets','fries','breakfast']);
  assert.equal(diverse.inventory.burgerbomb,0);
});

test('keeping a whole burger consumes one paid pack and supplies one bomb only',()=>{
  for(const id of WHOLE_BURGER_PACK_IDS){
    const whole=buildInventory([{id,mode:'whole'}]);
    assert.equal(whole.ok,true);assert.equal(whole.spent,PACKS.find(pack=>pack.id===id).cost);
    assert.equal(whole.inventory.burgerbomb,1);assert.equal(whole.wholeBurgers,1);
    assert.equal(Object.values(whole.inventory).reduce((sum,count)=>sum+count,0),1);
    const split=buildInventory([{id,mode:'split'}]);
    assert.equal(split.spent,whole.spent);assert.equal(split.inventory.burgerbomb,0);
    for(const [ingredient,count] of Object.entries(PACKS.find(pack=>pack.id===id).ingredients))assert.equal(split.inventory[ingredient],count);
  }
  const mixed=buildInventory([{id:'bigmac',mode:'split'},{id:'bigmac',mode:'whole'}]);
  assert.equal(mixed.spent,36);assert.equal(mixed.inventory.bun,2);assert.equal(mixed.inventory.burgerbomb,1);
  const twoWhole=buildInventory([{id:'bigmac',mode:'whole'},{id:'bigmac',mode:'whole'}]);
  assert.equal(twoWhole.spent,36);assert.equal(twoWhole.inventory.bun,0);assert.equal(twoWhole.inventory.burgerbomb,2);
});

test('invalid and over-budget purchases return an empty transaction',()=>{
  for(const [ids,options] of [
    [['bigmac','bigmac','bigmac','bigmac'],{}],
    [['unknown'],{}],
    [['fries','fries'],{maxPacks:1}],
    [['fries'],{budget:-1}],
    [['fries'],{budget:10.5}],
    [[{id:'fries',mode:'whole'}],{}],
    [[{id:'nuggets',mode:'whole'}],{}],
    [[{id:'bigmac',mode:'both'}],{}],
    [[{id:'bigmac'}],{}],
    [[null],{}],
    [null,{}],
  ]){
    const result=buildInventory(ids,options);
    assert.equal(result.ok,false);assert.ok(result.errors.length>0);
    assert.equal(result.spent,0);assert.ok(Object.values(result.inventory).every(count=>count===0));
  }
  const empty=buildInventory([]);assert.equal(empty.ok,true);assert.equal(empty.inventory.burgerbomb,0);
  const exact=buildInventory(['fries','fries','fries','fries','fries','fries']);
  assert.equal(exact.ok,true);assert.equal(exact.remaining,0);
});

test('each shot consumes exactly one available ingredient without mutating inventory',()=>{
  const inventory=Object.freeze({bun:1,ketchup:0,burgerbomb:1});
  const shot=consumeShot(inventory,'bun');
  assert.equal(shot.ok,true);assert.equal(shot.inventory.bun,0);assert.equal(inventory.bun,1);
  const exhausted=consumeShot(shot.inventory,'bun');assert.equal(exhausted.ok,false);assert.deepEqual(exhausted.inventory,shot.inventory);
  const unknown=consumeShot(inventory,'laser');assert.equal(unknown.ok,false);assert.deepEqual(unknown.inventory,inventory);
  const bomb=consumeShot(inventory,'burgerbomb');assert.equal(bomb.ok,true);assert.equal(bomb.inventory.burgerbomb,0);
  assert.equal(consumeShot({bun:.5},'bun').ok,false);
});

test('same ingredients clear only the connected local cluster',()=>{
  const target=block('hit','bun');
  const neighbors=[block('near','bun',1.2),block('chain','bun',2.4),block('beyond-radius','bun',3.6),block('gap','bun',0,0,3),block('other','patty',.8),block('removed','bun',.5,0,0,{removed:true})];
  const result=resolveHit({ammo:'bun',target,neighbors});
  assert.equal(result.type,'match');assert.deepEqual(result.removeIds,['hit','near','chain']);
  assert.deepEqual(result.damage,[]);
  const dense=Array.from({length:20},(_,i)=>block(`bun-${i}`,'bun',.05*i));
  assert.equal(resolveHit({ammo:'bun',target,neighbors:dense}).removeIds.length,MATCH_RULES.maxBlocks);
});

test('a mismatched ingredient gives impact feedback while preserving the structure',()=>{
  const result=resolveHit({ammo:'nugget',target:block('onion','onion'),neighbors:[block('near','nugget',.5)]});
  assert.equal(result.type,'impact');assert.deepEqual(result.removeIds,[]);assert.deepEqual(result.damage,[]);
  assert.ok(result.impulse>0);
});

test('ketchup and bun trigger a connected breakfast recipe in both directions',()=>{
  const target=block('bread','bun');
  const result=resolveHit({ammo:'ketchup',target,neighbors:[block('sausage','sausage',1.1),block('sauce','ketchup',0,1.1),block('patty','patty',.3),block('far','sausage',3)]});
  assert.equal(result.type,'combo');assert.equal(result.combo,'breakfast');assert.equal(result.label,'早餐开锅');
  assert.deepEqual(new Set(result.removeIds),new Set(['bread','sausage','sauce']));
  const reverse=resolveHit({ammo:'bun',target:block('sauce','ketchup')});
  assert.equal(reverse.combo,'breakfast');
});

test('patty and bun clear burger layers within a narrow vertical column',()=>{
  const result=resolveHit({ammo:'patty',target:block('bread','bun'),neighbors:[
    block('meat','patty',0,1.1),block('onion','onion',0,2.2),block('other-column','bun',1.1),block('sausage','sausage',.1,.1),
  ]});
  assert.equal(result.combo,'burger');assert.deepEqual(result.removeIds,['bread','meat','onion']);
  assert.equal(resolveHit({ammo:'bun',target:block('meat','patty')}).combo,'burger');
});

test('fries and ketchup clear a shallow connected layer without removing upper floors',()=>{
  const result=resolveHit({ammo:'fry',target:block('sauce','ketchup'),neighbors:[
    block('fries','fry',1.1),block('more-fries','fry',2.2),block('upper','fry',0,1),block('bun','bun',.5),
  ]});
  assert.equal(result.combo,'dip');assert.deepEqual(result.removeIds,['sauce','fries','more-fries']);
  assert.equal(resolveHit({ammo:'ketchup',target:block('fries','fry')}).combo,'dip');
});

test('burger bomb clears nearby ingredients with a bounded radius and respects protected blocks',()=>{
  const result=resolveHit({ammo:'burgerbomb',target:block('bread','bun'),neighbors:[
    block('meat','patty',1),block('onion','onion',0,2),block('edge','nugget',MATCH_RULES.bombRadius),
    block('far','fry',MATCH_RULES.bombRadius+.01),block('protected','sausage',.5,0,0,{destructible:false}),
  ]});
  assert.equal(result.type,'bomb');assert.deepEqual(new Set(result.removeIds),new Set(['bread','meat','onion','edge']));
});

test('resolution ignores stale and malformed contacts and keeps input nodes immutable',()=>{
  const target=Object.freeze(block('bread','bun'));
  const neighbor=Object.freeze(block('another','bun',1));
  const neighbors=Object.freeze([neighbor,block('another','bun',1),null,block('dead','bun',.5,0,0,{hp:0})]);
  const result=resolveHit({ammo:INGREDIENTS[0],target,neighbors});
  assert.deepEqual(result.removeIds,['bread','another']);
  assert.equal(target.hp,1);assert.equal(neighbor.hp,1);
  for(const input of [undefined,{ammo:'laser',target},{ammo:'bun',target:block('bad','bun',NaN)},{ammo:'bun',target:{id:'missing'}}]){
    assert.deepEqual(resolveHit(input).removeIds,[]);
  }
});

test('corn chips every food eight times, clears one target, and leaves neighbors intact',()=>{
  for(const {id} of INGREDIENTS){
    let target=Object.freeze(block('target',id));
    const neighbor=Object.freeze(block('neighbor',id,.5));
    for(let hit=1;hit<=CORN_HITS_TO_CLEAR;hit++){
      const result=resolveHit({ammo:'corn',target,neighbors:[neighbor]});
      assert.equal(result.type,'chip');assert.equal(result.combo,null);
      assert.deepEqual(result.damage,[{id:'target',amount:1,remaining:CORN_HITS_TO_CLEAR-hit}]);
      assert.deepEqual(result.removeIds,hit===CORN_HITS_TO_CLEAR?['target']:[]);
      assert.equal(neighbor.cornHp,undefined);
      target=Object.freeze({...target,cornHp:result.damage[0].remaining});
    }
    assert.deepEqual(resolveHit({ammo:'corn',target}).removeIds,[]);
    assert.deepEqual(resolveHit({ammo:'corn',target}).damage,[]);
  }
});

test('matching and recipe ammo clear a partly chipped target immediately',()=>{
  const target=Object.freeze(block('bread','bun',0,0,0,{cornHp:6}));
  const neighbor=Object.freeze(block('bread-two','bun',1,0,0,{cornHp:7}));
  assert.deepEqual(resolveHit({ammo:'bun',target,neighbors:[neighbor]}).removeIds,['bread','bread-two']);
  assert.equal(resolveHit({ammo:'patty',target}).type,'combo');
  assert.equal(target.cornHp,6);
  assert.deepEqual(consumeShot({corn:2},'corn').inventory,{corn:1});
});

test('corn rejects protected, stale and malformed durability without applying damage',()=>{
  for(const extra of [{removed:true},{destructible:false},{hp:0},{cornHp:0},{cornHp:-1},{cornHp:.5},{cornHp:Infinity},{cornHp:9}]){
    const result=resolveHit({ammo:'corn',target:block('food','fry',0,0,0,extra)});
    assert.deepEqual(result.damage,[]);assert.deepEqual(result.removeIds,[]);
  }
});
