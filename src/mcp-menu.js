const MAX_TEXT = 2 * 1024 * 1024;
const MAX_ITEMS = 2000;
const MAX_STORES = 100;
const cleanName = value => value.normalize('NFKC').replace(/[\s·•()（）®™]/g, '').toLowerCase();
const text = (value, max = 120) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
const code = value => text(value, 80);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;

function amount(value, { cents = false } = {}) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value))) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > (cents ? 10_000_000 : 100_000)) return null;
  if (cents && !Number.isInteger(number)) return null;
  return cents ? number / 100 : Math.round(number * 100) / 100;
}

// Unwrap only the documented MCP and success/data envelopes. Arbitrary text,
// unrelated nested account records and unsuccessful results are not meal data.
function payloads(response) {
  const result = response?.result ?? response;
  if (!result || typeof result !== 'object' || result.isError || result.success === false) return [];
  const roots = [];
  if (result.structuredContent) roots.push(result.structuredContent);
  for (const block of (Array.isArray(result.content) ? result.content : []).slice(0, 8)) {
    if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length > MAX_TEXT) continue;
    try { roots.push(JSON.parse(block.text)); } catch { /* Unsupported text stays unparsed. */ }
  }
  if (!roots.length && !('content' in result) && !('structuredContent' in result)) roots.push(result);
  return roots.flatMap(root => {
    let value = root;
    for (let depth = 0; depth < 6; depth += 1) {
      if (typeof value === 'string') {
        if (value.length > MAX_TEXT) return [];
        try { value = JSON.parse(value); } catch { return []; }
      }
      if (!value || value.isError || value.success === false) return [];
      if (object(value) && Object.hasOwn(value, 'success') && value.code !== undefined && ![0, 200, '0', '200'].includes(value.code)) return [];
      if (object(value) && Object.hasOwn(value, 'data')) { value = value.data; continue; }
      return [value];
    }
    return [];
  });
}

export function buildShanghaiStoreSearch(keyword = '人民广场') {
  const landmark = text(keyword, 100);
  if (!landmark) throw new TypeError('请填写上海的门店名或公开地标。');
  return { searchType: 2, beType: 1, city: '上海市', keyword: landmark };
}

export function buildPickupMenuArguments(store) {
  const storeCode = code(typeof store === 'string' ? store : store?.code);
  if (!storeCode) throw new TypeError('请先选择门店。');
  return { storeCode, orderType: 1, beType: 1 };
}

export function buildPickupQuoteArguments(store, items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new TypeError('请先选择餐品。');
  return { ...buildPickupMenuArguments(store), items: items.map(item => {
    const productCode = code(item?.productCode);
    if (!productCode || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) throw new TypeError('餐品编码或份数无效。');
    return { productCode, quantity: item.quantity };
  }) };
}

export function normalizeStores(response) {
  const stores = new Map();
  for (const payload of payloads(response)) {
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.stores) ? payload.stores : [];
    for (const row of rows.slice(0, MAX_STORES)) {
      const storeCode = code(row?.storeCode);
      const name = text(row?.storeName);
      if (!storeCode || !name || stores.has(storeCode)) continue;
      stores.set(storeCode, {
        code: storeCode, name, address: text(row.address, 300), beCode: code(row.beCode),
        businessStatus: typeof row.businessStatus === 'boolean' ? row.businessStatus : null,
      });
      if (stores.size >= MAX_STORES) break;
    }
  }
  return [...stores.values()];
}

function menuItem(raw, itemCode) {
  const name = text(raw?.name);
  if (!code(itemCode) || !name) return null;
  const originalPriceYuan = amount(raw.originalPrice);
  const publicDiscount = raw.discountType === null || raw.discountType === undefined || raw.discountType === '' || raw.discountType === '促销优惠';
  const currentPriceYuan = publicDiscount ? amount(raw.currentPrice) : null;
  const publicPriceYuan = currentPriceYuan ?? originalPriceYuan;
  return {
    code: itemCode, name, publicPriceYuan, originalPriceYuan,
    priceSource: currentPriceYuan !== null ? (raw.discountType === '促销优惠' ? 'public-promotion' : 'menu-current') : originalPriceYuan !== null ? 'menu-original' : 'unknown',
    requiresCustomization: Array.isArray(raw.rounds) ? raw.rounds.length > 0 : null,
  };
}

export function normalizeMenu(response, { store = null, retrievedAt = response?.retrievedAt } = {}) {
  const items = new Map();
  for (const payload of payloads(response)) {
    if (!object(payload?.meals)) continue;
    for (const [itemCode, raw] of Object.entries(payload.meals).slice(0, MAX_ITEMS)) {
      const item = menuItem(raw, itemCode);
      if (item && !items.has(item.code)) items.set(item.code, item);
      if (items.size >= MAX_ITEMS) break;
    }
  }
  return {
    source: 'official-mcp-menu', store: { code: code(store?.code), name: text(store?.name) },
    orderType: 1, beType: 1, currency: 'CNY', retrievedAt: date(retrievedAt),
    items: [...items.values()], itemCount: items.size,
  };
}

export function matchPackPrices(menu, packs) {
  const matched = [], unmatched = [], ambiguous = [];
  for (const pack of packs) {
    const names = [pack.name, ...(pack.mcpAliases || [])].filter(name => typeof name === 'string').map(cleanName);
    const candidates = (menu?.items || []).filter(item => names.includes(cleanName(item.name)));
    if (candidates.length === 1) matched.push({ packId: pack.id, ...candidates[0] });
    else {
      unmatched.push(pack.id);
      if (candidates.length > 1) ambiguous.push(pack.id);
    }
  }
  return { matched, unmatched, ambiguous };
}

export function menuIdentityCandidates(menu, packs) {
  const aliases = new Set(packs.flatMap(pack => pack.mcpMenuAliases || []).filter(name => typeof name === 'string').map(cleanName));
  return (menu?.items || []).filter(item => typeof item.name === 'string' && aliases.has(cleanName(item.name)));
}

// A generic menu label identifies a detail-query candidate. Only the same SKU's
// explicit, size-specific detail name can establish its game-pack identity.
export function resolveMenuIdentity(item, detail, packs) {
  if (!detail || detail.code !== item.code || typeof detail.name !== 'string') return item;
  const candidates = packs.filter(pack => (pack.mcpMenuAliases || []).some(name => cleanName(name) === cleanName(item.name)));
  const precise = candidates.some(pack => [pack.name, ...(pack.mcpAliases || [])].some(name => cleanName(name) === cleanName(detail.name)));
  return precise ? { ...item, name: detail.name, menuName: item.name, identitySource: 'meal-detail' } : item;
}

export async function enrichMenuIdentities(menu, packs, { loadDetail, isCurrent = () => true }) {
  const details = new Map();
  const resolved = new Map();
  for (const item of menuIdentityCandidates(menu, packs).slice(0, 20)) {
    if (!isCurrent()) break;
    let detail = null;
    try { detail = normalizeMealDetail(await loadDetail(item.code)); }
    catch (error) {
      if (!isCurrent()) break;
      if (error?.code === 'needs-auth' || error?.state === 'needs-auth') throw error;
    }
    if (!isCurrent()) break;
    if (detail?.code !== item.code) detail = null;
    details.set(item.code, detail);
    resolved.set(item.code, resolveMenuIdentity(item, detail, packs));
  }
  return { menu: { ...menu, items: menu.items.map(item => resolved.get(item.code) || item) }, details };
}

// Detail options describe removable/customizable components. They carry no
// claim about a complete recipe, grams, slices or game ammunition quantities.
export function normalizeMealDetail(response) {
  for (const payload of payloads(response)) {
    if (!code(payload?.code) || !text(payload?.name)) continue;
    const options = [];
    for (const group of (Array.isArray(payload.modification?.items) ? payload.modification.items : []).slice(0, 30)) {
      for (const option of (Array.isArray(group.values) ? group.values : []).slice(0, 100)) {
        if (!code(option?.code) || !text(option?.name)) continue;
        const quantity = key => Number.isInteger(option[key]) && option[key] >= 0 && option[key] <= 999 ? option[key] : null;
        options.push({ code: option.code, name: option.name, selectedQuantity: quantity('selectedQuantity'), minQuantity: quantity('minQuantity'), maxQuantity: quantity('maxQuantity') });
      }
    }
    return { code: payload.code, name: payload.name, supportModify: payload.supportModify === true,
      hasChoices: Array.isArray(payload.rounds) && payload.rounds.length > 0, options,
      retrievedAt: date(response?.retrievedAt), source: 'official-mcp-detail' };
  }
  return null;
}

// Quotes can reflect this account's pricing. Keep this transient summary local;
// public snapshots use only normalizeMenu's public price fields.
export function normalizeQuote(response) {
  for (const payload of payloads(response)) {
    if (!object(payload) || !Object.hasOwn(payload, 'price')) continue;
    const totalYuan = amount(payload.price, { cents: true });
    if (totalYuan === null) continue;
    const cents = field => amount(payload[field], { cents: true });
    const items = (Array.isArray(payload.productList) ? payload.productList : []).slice(0, 100).flatMap(item => {
      if (!code(item?.productCode) || !Number.isInteger(item.quantity) || item.quantity < 1) return [];
      return [{ code: item.productCode, name: text(item.productName), quantity: item.quantity,
        subtotalYuan: amount(item.subtotal, { cents: true }), originalSubtotalYuan: amount(item.originalSubtotal, { cents: true }) }];
    });
    return { source: 'official-mcp-quote', currency: 'CNY', totalYuan, productYuan: cents('productPrice'),
      originalYuan: cents('originalPrice'), deliveryYuan: cents('deliveryPrice'), discountYuan: cents('discount'),
      tablewareYuan: cents('tablewarePrice'), items, retrievedAt: date(response?.retrievedAt), publicSnapshotEligible: false };
  }
  return null;
}

export function createPublicMenuSnapshot(menu) {
  if (menu?.source !== 'official-mcp-menu' || !code(menu.store?.code) || !text(menu.store?.name) || !date(menu.retrievedAt)) return null;
  const items = (Array.isArray(menu.items) ? menu.items : []).slice(0, MAX_ITEMS).flatMap(item => {
    if (!code(item?.code) || !text(item?.name)) return [];
    return [{ code: item.code, name: item.name, publicPriceYuan: amount(item.publicPriceYuan), originalPriceYuan: amount(item.originalPriceYuan),
      priceSource: ['menu-current', 'menu-original', 'public-promotion'].includes(item.priceSource) ? item.priceSource : 'unknown',
      requiresCustomization: typeof item.requiresCustomization === 'boolean' ? item.requiresCustomization : null }];
  });
  return { version: 1, source: 'official-mcp-menu', store: { code: menu.store.code, name: menu.store.name },
    orderType: 1, beType: 1, currency: 'CNY', retrievedAt: menu.retrievedAt, itemCount: items.length, items };
}
