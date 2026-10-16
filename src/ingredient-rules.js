// Product packs, ingredient quantities, prices and recipes are authored game
// rules. Nutrition records from MCP establish product identity only.
export const RULES_SOURCE='游戏份额不等于真实配方；补给点为游戏数值，MCP 营养数据用于识别商品';
export const PREP_BUDGET=60;
export const MAX_PACKS=6;
export const CORN_HITS_TO_CLEAR=8;

export const INGREDIENTS=Object.freeze([
  {id:'bun',name:'面包',color:'#e7a449',model:'bun',power:.65,description:'击中面包，消除相连面包；搭配肉饼组成汉堡。'},
  {id:'ketchup',name:'番茄酱',color:'#e74728',model:'ketchup',power:.35,description:'给面包或薯条蘸酱，触发专属组合。'},
  {id:'patty',name:'肉饼',color:'#794122',model:'patty',power:1.2,description:'击中同类消除肉饼；命中面包，拆掉一列汉堡夹层。'},
  {id:'onion',name:'洋葱',color:'#d6b4e9',model:'onion',power:.45,description:'消除相连洋葱，清理夹层中的薄支撑。'},
  {id:'sausage',name:'香肠',color:'#b76632',model:'sausage',power:1,description:'消除相连香肠，也能参与早餐组合。'},
  {id:'fry',name:'薯条',color:'#f5c54d',model:'fry',power:.5,description:'消除相连薯条；命中番茄酱，清理同层薯条。'},
  {id:'nugget',name:'鸡块',color:'#d99631',model:'nugget',power:.9,description:'消除相连鸡块，拆开紧密堆叠的鸡块墙。'},
  {id:'burgerbomb',name:'汉堡炸弹',color:'#e95a32',model:'burgerbomb',power:2.5,description:'配装时保留一整份汉堡作为炸弹，炸开命中点附近的食材。'},
  {id:'corn',name:'玉米粒',color:'#ffcf28',model:'corn',power:.2,description:'长按连射，命中任意食材八次即可击碎；同料弹药能更快连消。'},
].map(Object.freeze));

export const PACKS=Object.freeze([
  {id:'bigmac',name:'巨无霸',model:'bigmac',cost:18,ingredients:{bun:2,patty:2,onion:1,ketchup:1}},
  {id:'spicy',name:'麦辣鸡腿汉堡',model:'burger',cost:16,ingredients:{bun:2,patty:2,ketchup:2}},
  {id:'nuggets',name:'五块麦乐鸡',mcpAliases:Object.freeze(['麦乐鸡5块']),mcpMenuAliases:Object.freeze(['麦乐鸡']),model:'nuggets',cost:12,ingredients:{nugget:5}},
  {id:'fries',name:'中薯条',mcpMenuAliases:Object.freeze(['薯条']),model:'fries',cost:10,ingredients:{fry:6,ketchup:2}},
  {id:'breakfast',name:'早餐补给',model:'burger',cost:16,ingredients:{bun:2,sausage:3}},
  {id:'fish',name:'麦香鱼',model:'fishburger',cost:14,ingredients:{bun:2,patty:1,ketchup:1}},
].map(pack=>Object.freeze({...pack,ingredients:Object.freeze(pack.ingredients)})));

export const WHOLE_BURGER_PACK_IDS=Object.freeze(['bigmac','spicy','fish','breakfast']);
export const DEFAULT_PACK_IDS=Object.freeze([
  Object.freeze({id:'bigmac',mode:'split'}),'fries','nuggets',Object.freeze({id:'spicy',mode:'whole'}),
]);
export const MATCH_RULES=Object.freeze({linkDistance:1.55,radius:3.4,maxBlocks:8,bombRadius:2.7});
export const COMBOS=Object.freeze([
  Object.freeze({id:'breakfast',name:'早餐开锅',pair:Object.freeze(['ketchup','bun']),description:'消除命中处相连的面包、番茄酱和香肠，最多四块。'}),
  Object.freeze({id:'burger',name:'汉堡合体',pair:Object.freeze(['patty','bun']),description:'消除命中处一列面包、肉饼和洋葱，最多五块。'}),
  Object.freeze({id:'dip',name:'薯条蘸酱',pair:Object.freeze(['fry','ketchup']),description:'消除命中处同层相连的薯条与番茄酱，最多五块。'}),
]);

const ingredientById=new Map(INGREDIENTS.map(ingredient=>[ingredient.id,ingredient]));
const packById=new Map(PACKS.map(pack=>[pack.id,pack]));
const emptyInventory=()=>Object.fromEntries(INGREDIENTS.map(ingredient=>[ingredient.id,0]));

/**
 * Rebuild a preparation transaction. Each paid pack becomes either its authored
 * ingredient portions or one whole-burger bomb. Strings default to split mode.
 */
export function buildInventory(selectedPackIds,{budget=PREP_BUDGET,maxPacks=MAX_PACKS}={}){
  const errors=[];
  if(!Number.isSafeInteger(budget)||budget<0)errors.push('补给预算须为非负整数');
  if(!Number.isSafeInteger(maxPacks)||maxPacks<1)errors.push('补给份数上限须为正整数');
  if(!Array.isArray(selectedPackIds))errors.push('请选择补给列表');
  const entries=Array.isArray(selectedPackIds)?selectedPackIds.map(entry=>typeof entry==='string'?{id:entry,mode:'split'}:{id:entry?.id,mode:entry?.mode}):[];
  if(entries.length>maxPacks)errors.push(`最多准备 ${maxPacks} 份补给`);
  for(const {id,mode} of entries){
    if(!packById.has(id))errors.push(`无法识别补给：${String(id)}`);
    if(!['split','whole'].includes(mode))errors.push('每份补给请选择拆食材或保留整堡');
    if(mode==='whole'&&!WHOLE_BURGER_PACK_IDS.includes(id))errors.push('只有汉堡补给可以保留整堡炸弹');
  }
  const total=entries.reduce((sum,{id})=>sum+(packById.get(id)?.cost??0),0);
  if(Number.isFinite(budget)&&total>budget)errors.push(`补给超出预算 ${total-budget} 点`);
  if(errors.length)return {ok:false,inventory:emptyInventory(),spent:0,remaining:Number.isSafeInteger(budget)&&budget>=0?budget:0,selectedPackIds:[],selectedPacks:[],wholeBurgers:0,errors,error:errors[0]};
  const inventory=emptyInventory();
  for(const {id,mode} of entries){
    if(mode==='whole')inventory.burgerbomb+=1;
    else for(const [ingredient,count] of Object.entries(packById.get(id).ingredients))inventory[ingredient]+=count;
  }
  return {ok:true,inventory,spent:total,remaining:budget-total,selectedPackIds:entries.map(entry=>entry.id),selectedPacks:entries,wholeBurgers:inventory.burgerbomb,errors:[],error:null};
}

export function initialLoadout(options){return buildInventory(DEFAULT_PACK_IDS,options);}

/** Consume exactly one shot and leave the caller's inventory unchanged. */
export function consumeShot(inventory,ammoId){
  const next={...inventory};
  if(!ingredientById.has(ammoId))return {ok:false,inventory:next,ammo:null,error:'请选择一种食材'};
  if(!Number.isSafeInteger(inventory?.[ammoId])||inventory[ammoId]<1)return {ok:false,inventory:next,ammo:ammoId,error:'这份食材已经用完'};
  next[ammoId]-=1;
  return {ok:true,inventory:next,ammo:ammoId,error:null};
}

const distanceSquared=(a,b)=>(a.x-b.x)**2+(a.y-b.y)**2+(a.z-b.z)**2;
const horizontalDistanceSquared=(a,b)=>(a.x-b.x)**2+(a.z-b.z)**2;
const validNode=node=>!!node&&node.id!==undefined&&node.id!==null&&ingredientById.has(node.ingredient)
  &&[node.x,node.y,node.z].every(Number.isFinite)&&!node.removed&&node.destructible!==false&&(node.hp===undefined||node.hp>0);
const byDistance=origin=>(a,b)=>distanceSquared(a,origin)-distanceSquared(b,origin)||String(a.id).localeCompare(String(b.id));

function connected(target,nodes,{accept,radius,maxBlocks,linkDistance=MATCH_RULES.linkDistance}){
  const candidates=nodes.filter(node=>accept(node)&&distanceSquared(node,target)<=radius**2+1e-8).sort(byDistance(target));
  const selected=[],seen=new Set(),queue=[target];
  while(queue.length&&selected.length<maxBlocks){
    const current=queue.shift();
    if(seen.has(current.id))continue;
    seen.add(current.id);selected.push(current);
    for(const candidate of candidates)if(!seen.has(candidate.id)&&distanceSquared(candidate,current)<=linkDistance**2+1e-8)queue.push(candidate);
  }
  return selected;
}

/**
 * Resolve one physical contact. Nodes are plain {id,ingredient,x,y,z,hp} data.
 * Corn chips one target's separate durability. Ingredient matching and recipes
 * remove blocks directly. Main applies the returned damage and animation.
 */
export function resolveHit({ammo,target,neighbors=[]}={}){
  const ammoId=typeof ammo==='string'?ammo:ammo?.id,ingredient=ingredientById.get(ammoId);
  const result={type:'impact',label:'换种食材试试',removeIds:[],damage:[],combo:null,impulse:ingredient?.power??0};
  if(!ingredient||!validNode(target))return result;
  if(ammoId==='corn'){
    const health=target.cornHp??CORN_HITS_TO_CLEAR;
    if(!Number.isSafeInteger(health)||health<1||health>CORN_HITS_TO_CLEAR)return result;
    const remaining=health-1;
    return {...result,type:'chip',label:remaining?`命中！还需 ${remaining} 粒`:'玉米击碎！',
      removeIds:remaining?[]:[target.id],damage:[{id:target.id,amount:1,remaining}]};
  }
  const unique=new Map([[target.id,target]]);
  for(const node of Array.isArray(neighbors)?neighbors:[])if(validNode(node)&&!unique.has(node.id))unique.set(node.id,node);
  const nodes=[...unique.values()];
  if(ammoId==='burgerbomb'){
    const removed=nodes.filter(node=>distanceSquared(node,target)<=MATCH_RULES.bombRadius**2+1e-8).sort(byDistance(target));
    return {...result,type:'bomb',label:'汉堡炸弹！',removeIds:removed.map(node=>node.id)};
  }
  if(ammoId===target.ingredient){
    const removed=connected(target,nodes,{accept:node=>node.ingredient===ammoId,radius:MATCH_RULES.radius,maxBlocks:MATCH_RULES.maxBlocks});
    return {...result,type:'match',label:removed.length>1?`${removed.length} 块同料连消`:'同料消除',removeIds:removed.map(node=>node.id)};
  }
  const combo=COMBOS.find(recipe=>recipe.pair.includes(ammoId)&&recipe.pair.includes(target.ingredient));
  if(!combo)return result;
  let removed;
  if(combo.id==='breakfast'){
    removed=connected(target,nodes,{accept:node=>['bun','ketchup','sausage'].includes(node.ingredient),radius:2.1,maxBlocks:4});
  }else if(combo.id==='burger'){
    removed=connected(target,nodes,{accept:node=>['bun','patty','onion'].includes(node.ingredient)&&horizontalDistanceSquared(node,target)<=.85**2,radius:3,maxBlocks:5});
  }else{
    removed=connected(target,nodes,{accept:node=>['fry','ketchup'].includes(node.ingredient)&&Math.abs(node.y-target.y)<=.65,radius:2.4,maxBlocks:5});
  }
  return {...result,type:'combo',label:combo.name,combo:combo.id,removeIds:removed.map(node=>node.id)};
}
