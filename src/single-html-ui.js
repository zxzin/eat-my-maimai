import { PACKS } from './ingredient-rules.js';

/** Dedicated offline UI: consumes only the public build snapshot and has no network client. */
export function setupSingleHtmlUI({ onLive, onDemo, onMenu, snapshot = globalThis.__MAIMAI_PUBLIC_SNAPSHOT__ } = {}) {
  const $ = id => document.getElementById(id);
  const products = Array.isArray(snapshot?.products) ? snapshot.products : [];
  const byId = new Map(products.map(product => [product.packId, product]));
  const matchedIds = new Set(Array.isArray(snapshot?.nutrition?.matchedIds) ? snapshot.nutrition.matchedIds : []);
  const matched = PACKS.filter(pack => matchedIds.has(pack.id)).map(pack => ({
    ...pack,
    source: { kind: 'official-mcp-public-snapshot', retrievedAt: snapshot.nutrition.retrievedAt, productName: pack.name },
  }));
  $('mcpBadge').textContent = snapshot ? '离线餐品快照' : '离线试玩 · 直接开玩';
  $('mcpStatus').textContent = snapshot ? '公开餐品快照已装入' : '离线试玩';
  $('mcpFoods').replaceChildren();
  if (snapshot) {
    const date = snapshot.retrievedAt ? new Date(snapshot.retrievedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '打包时';
    const store = [snapshot.store?.city, snapshot.store?.name].filter(Boolean).join(' · ');
    $('mcpMessage').textContent = `${date} 的餐品快照${store ? `，参考门店：${store}` : ''}。打开本页即可离线游玩。`;
    for (const pack of PACKS.filter(pack => byId.has(pack.id))) {
      const element = document.createElement('span');
      const price = byId.get(pack.id).publicPriceYuan;
      element.textContent = `${pack.name}${Number.isFinite(price) ? ` · 参考 ¥${price.toFixed(2)}` : ''}`;
      $('mcpFoods').append(element);
    }
    $('mcpFoods').hidden = !products.length;
    if (matched.length) onLive?.(matched);
    else onDemo?.();
    onMenu?.(snapshot);
  } else {
    $('mcpMessage').textContent = '完整游戏已装进这一页。无需联网，选餐装弹后即可开战。';
    $('mcpFoods').hidden = true;
    onDemo?.();
  }
  return { ready: Promise.resolve() };
}
