import { loadMcpStores, loadMcpMenu, loadMcpMealDetail, loadMcpQuote } from './mcp-client.js';
import { normalizeStores, normalizeMenu, matchPackPrices, normalizeMealDetail, normalizeQuote, buildShanghaiStoreSearch, buildPickupMenuArguments, enrichMenuIdentities } from './mcp-menu.js';
import { PACKS } from './ingredient-rules.js';

const $ = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? `¥${value.toFixed(2)}` : '价格待核验';
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间待核验';

export function setupMcpPriceUI({ onMenu, getSelection, onBusyChange = () => {}, onConnectionError = () => {}, api = { loadMcpStores, loadMcpMenu, loadMcpMealDetail, loadMcpQuote } }) {
  let connected = false, busy = false, stores = [], store = null, menu = null, matches = [], nutrition = null;
  let externalBusy = false;
  let revision = 0;
  const authFailure = error => error?.code === 'needs-auth' || error?.state === 'needs-auth';
  function controls() {
    $('storeSearchButton').disabled = !connected || busy || externalBusy;
    $('storeSelect').disabled = !connected || busy || externalBusy || !stores.length;
    $('menuSyncButton').disabled = !connected || busy || externalBusy || !store;
    $('quoteButton').disabled = !connected || busy || externalBusy || !matches.length;
  }
  function message(value, error = false) {
    $('menuMessage').textContent = value;
    $('menuMessage').classList.toggle('is-error', error);
  }
  function clearMenu() {
    menu = null; matches = []; onMenu(null);
    $('menuResults').replaceChildren(); $('menuResults').hidden = true;
    $('menuUpdatedAt').textContent = ''; $('quoteResult').textContent = '';
  }
  function invalidate() { revision += 1; busy = false; onBusyChange(false); }
  async function run(task, internalRefresh = false) {
    if (busy || !connected || (externalBusy && !internalRefresh)) return;
    const ownRevision = ++revision;
    const current = () => connected && revision === ownRevision;
    busy = true; controls(); onBusyChange(true);
    try { await task(current); }
    catch (error) {
      if (current()) {
        if (authFailure(error)) {
          connected = false; invalidate(); clearMenu(); controls(); onConnectionError(error);
          return;
        }
        message(error.message || '菜单读取未完成，请重试。', true);
        if ($('quoteResult').textContent === '正在核对本次配餐价格…') $('quoteResult').textContent = '本次核价未完成，请重试。';
      }
    }
    finally { if (current()) { busy = false; controls(); onBusyChange(false); } }
  }
  function snapshot() {
    return {
      schemaVersion: 1, retrievedAt: menu.retrievedAt,
      store: { code: store.code, name: store.name, city: '上海市', address: store.address || '' },
      nutrition,
      products: matches.map(({ packId, code, name, publicPriceYuan, originalPriceYuan, priceSource }) => ({ packId, code, name, publicPriceYuan, originalPriceYuan, priceSource })),
    };
  }
  function renderMenu() {
    $('menuResults').replaceChildren();
    for (const item of matches) {
      const row = document.createElement('div'); row.className = 'menu-product';
      const name = document.createElement('strong'); name.textContent = PACKS.find(pack => pack.id === item.packId)?.name || item.name;
      const price = document.createElement('span'); price.textContent = money(item.publicPriceYuan);
      const note = document.createElement('small'); note.textContent = item.priceSource === 'menu-original' ? '门店原价' : item.priceSource === 'unknown' ? '等待官方价格' : '门店参考价';
      row.append(name, price, note); row.dataset.menuPack = item.packId;
      $('menuResults').append(row);
    }
    $('menuStoreLabel').textContent = `${store.name} · 到店自取`;
    $('menuUpdatedAt').textContent = `同步于 ${time(menu.retrievedAt)}`;
    $('menuResults').hidden = false;
    $('quoteResult').textContent = '';
  }
  async function search(current) {
    const keyword = $('storeKeyword').value.trim() || '人民广场';
    clearMenu(); stores = []; store = null; $('storeSelect').replaceChildren();
    $('menuStoreLabel').textContent = '正在查找上海参考门店';
    message('正在查找上海门店…');
    const response = await api.loadMcpStores(buildShanghaiStoreSearch(keyword));
    if (!current()) return false;
    stores = normalizeStores(response);
    const eligible = stores.filter(item => item.businessStatus !== false);
    stores = eligible.length ? eligible : stores;
    $('storeSelect').replaceChildren();
    for (const item of stores) {
      const option = document.createElement('option'); option.value = item.code; option.textContent = item.name;
      $('storeSelect').append(option);
    }
    store = stores[0] || null;
    $('storeSelect').value = store?.code || '';
    if (!store) { $('menuStoreLabel').textContent = '未找到门店'; message('换一个上海地标或门店名称，再搜索一次。'); return false; }
    $('menuStoreLabel').textContent = `${store.name} · 到店自取`;
    message(`找到 ${stores.length} 家门店，可切换参考门店。`);
    return true;
  }
  async function syncSelected(current) {
    if (!store) return;
    const selectedStore = store;
    const requestArguments = buildPickupMenuArguments(selectedStore.code);
    clearMenu();
    message('正在同步门店菜单和公开价格…');
    const response = await api.loadMcpMenu(requestArguments);
    if (!current()) return;
    menu = normalizeMenu(response, { store: selectedStore, retrievedAt: response.retrievedAt });
    if (!menu.itemCount) throw new Error('官方本次未返回可识别的门店菜单，请稍后重试或选择其他门店。');
    const enriched = await enrichMenuIdentities(menu, PACKS, {
      loadDetail: code => api.loadMcpMealDetail({ ...requestArguments, code }), isCurrent: current,
    });
    if (!current()) return;
    menu = enriched.menu;
    matches = matchPackPrices(menu, PACKS).matched;
    renderMenu(); onMenu(matches.length ? snapshot() : null);
    message(`已读取 ${menu.itemCount} 项门店商品，${matches.length} 款支持当前配装。价格以所选门店和同步时间为准。`);
    // Only matched products are inspected. Optional modifications are shown as
    // official choices, while the game keeps its authored ingredient quantities.
    // The credential bridge accepts one official request at a time.
    for (const item of matches) {
      if (!current()) return;
      let detail;
      try { detail = enriched.details.has(item.code) ? enriched.details.get(item.code) : normalizeMealDetail(await api.loadMcpMealDetail({ ...requestArguments, code: item.code })); }
      catch (error) { if (!current()) return; if (authFailure(error)) throw error; continue; }
      if (!current()) return;
      const row = [...$('menuResults').children].find(element => element.dataset.menuPack === item.packId);
      const modifications = detail?.code === item.code ? detail.options || [] : [];
      if (!row || !modifications.length) continue;
      const disclosure = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = '查看官方可调整食材';
      const description = document.createElement('p'); description.textContent = modifications.map(mod => mod.name).join('、') + '。这是可调整选项，游戏拆解份额另行设定。';
      disclosure.append(summary, description); row.append(disclosure);
    }
  }
  $('storeSearchForm').addEventListener('submit', event => { event.preventDefault(); return run(async current => { if (await search(current)) await syncSelected(current); }); });
  $('storeSelect').addEventListener('change', () => {
    if (!connected || externalBusy) return;
    invalidate();
    store = stores.find(item => item.code === $('storeSelect').value) || null;
    clearMenu();
    $('menuStoreLabel').textContent = store ? `${store.name} · 到店自取` : '选择参考门店';
    message('点击“同步门店菜单”读取这家店的最新价格。'); controls();
  });
  $('menuSyncButton').addEventListener('click', () => run(syncSelected));
  $('quoteButton').addEventListener('click', () => run(async current => {
    const counts = new Map();
    for (const entry of getSelection()) { const id = typeof entry === 'string' ? entry : entry.id; counts.set(id, (counts.get(id) || 0) + 1); }
    const missing = [...counts.keys()].filter(id => !matches.some(item => item.packId === id));
    if (!counts.size || missing.length) { $('quoteResult').textContent = '请先选择本店可核价的餐品；演示补给不参与真实价格计算。'; return; }
    const items = [...counts].map(([id, quantity]) => ({ productCode: matches.find(item => item.packId === id).code, quantity }));
    $('quoteResult').textContent = '正在核对本次配餐价格…';
    const quote = normalizeQuote(await api.loadMcpQuote({ ...buildPickupMenuArguments(store.code), items }));
    if (!current()) return;
    $('quoteResult').textContent = quote
      ? `本次配餐参考合计 ${money(quote.totalYuan)} · 仅核价，游戏使用金币。`
      : '官方暂未返回可识别的核价金额，请稍后重试。';
  }));
  controls();
  return {
    setExternalBusy(value) { externalBusy = Boolean(value); controls(); },
    setConnected(value) {
      connected = Boolean(value);
      if (!connected) {
        invalidate(); clearMenu(); stores = []; store = null; nutrition = null;
        $('storeSelect').replaceChildren(); $('menuStoreLabel').textContent = '选择上海参考门店';
        message('连接 MCP 后，可同步上海门店菜单与价格。');
      }
      controls();
    },
    async refresh(data) {
      await run(async current => {
        nutrition = { retrievedAt: data.retrievedAt, foodCount: data.foodCount, matchedIds: data.matched.map(item => item.id) };
        if (store || await search(current)) await syncSelected(current);
      }, true);
    },
  };
}
