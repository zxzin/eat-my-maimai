const NAME_FIELDS = ['name', 'foodName', 'food_name', 'productName', 'product_name', 'mealName', '餐品名称', '餐品', '食品名称', '名称'];
const clean = value => String(value).normalize('NFKC').replace(/[\s·•()（）®™]/g, '').toLowerCase();
const MAX_TOON_CHARS = 512 * 1024;
const MAX_FOODS = 2000;

function parseToonRow(line) {
  const values = [];
  let index = 0;
  while (index < line.length) {
    while (line[index] === ' ' || line[index] === '\t') index += 1;
    if (line[index] === '"') {
      const start = index++;
      let closed = false;
      while (index < line.length) {
        if (line[index] === '\\') { index += 2; continue; }
        if (line[index++] === '"') { closed = true; break; }
      }
      if (!closed) return null;
      try { values.push(JSON.parse(line.slice(start, index))); } catch { return null; }
      while (line[index] === ' ' || line[index] === '\t') index += 1;
      if (index < line.length && line[index] !== ',') return null;
    } else {
      const start = index;
      while (index < line.length && line[index] !== ',') index += 1;
      const value = line.slice(start, index).trim();
      if (!value || /["\r\n]/.test(value)) return null;
      values.push(value === 'null' ? null : value);
    }
    if (values.length > 32) return null;
    if (index === line.length) break;
    index += 1;
    if (index === line.length) return null;
  }
  return values;
}

// Parse the bounded root-array TOON form published in the official nutrition
// documentation. Unsupported shapes and incomplete rows yield no products.
export function parseNutritionToon(value) {
  if (typeof value !== 'string' || value.length > MAX_TOON_CHARS) return [];
  const lines = value.trim().replace(/\r\n/g, '\n').split('\n');
  const header = /^\[(\d{1,4})\]\{([^}\r\n]{1,512})\}:[ \t]*$/.exec(lines[0]);
  if (!header) return [];
  const count = Number(header[1]);
  const fields = header[2].split(',').map(field => field.trim());
  if (count > MAX_FOODS || lines.length !== count + 1 || fields.length > 32
    || fields.some(field => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field))
    || new Set(fields).size !== fields.length || !fields.includes('productName')) return [];
  const rows = [];
  const nameIndex = fields.indexOf('productName');
  for (const line of lines.slice(1)) {
    const values = parseToonRow(line.trim());
    if (!values || values.length !== fields.length) return [];
    const name = values[nameIndex];
    if (typeof name !== 'string' || !name.trim() || name.length > 120) return [];
    rows.push({ productName: name });
  }
  return rows;
}

// Only structured objects carrying a food-name field become food records.
// A text mention, Markdown table, tool description, or error cannot unlock ammo.
export function extractNutritionFoods(result) {
  const roots = [];
  if (result?.isError) return [];
  if (result?.structuredContent) roots.push(result.structuredContent);
  for (const block of result?.content || []) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    try { roots.push(JSON.parse(block.text)); } catch { roots.push(block.text); }
  }
  const foods = [];
  const seenNames = new Set();
  const visit = (value, depth = 0) => {
    if (!value || depth > 12 || foods.length >= MAX_FOODS) return;
    if (typeof value === 'string') {
      parseNutritionToon(value).forEach(row => visit(row, depth + 1));
      return;
    }
    if (typeof value !== 'object' || value.success === false) return;
    if (Array.isArray(value)) { value.forEach(entry => visit(entry, depth + 1)); return; }
    const name = NAME_FIELDS.map(field => value[field]).find(entry => typeof entry === 'string' && entry.trim());
    if (name && name.length <= 120 && !seenNames.has(clean(name))) {
      seenNames.add(clean(name));
      foods.push({ name: name.trim() });
    }
    for (const [key, entry] of Object.entries(value)) {
      if (entry && typeof entry === 'object') visit(entry, depth + 1);
      else if (key === 'data' && typeof entry === 'string') visit(entry, depth + 1);
    }
  };
  roots.forEach(root => visit(root));
  return foods;
}

// A nutrition match confirms catalog membership. Store availability and quotes
// require query-meals and calculate-price, and are never inferred here.
export function buildLiveLoadout(result, catalog, retrievedAt = new Date().toISOString()) {
  const foods = extractNutritionFoods(result);
  const byName = new Map(foods.map(food => [clean(food.name), food]));
  const matched = [];
  const unmatched = [];
  for (const ammo of catalog) {
    const names = [ammo.name, ammo.source?.productName, ...(ammo.mcpAliases || [])].filter(Boolean);
    const food = names.map(name => byName.get(clean(name))).find(Boolean);
    if (food) {
      matched.push({
        ...ammo,
        source: {
          kind: 'official-mcp-live', endpoint: 'https://mcp.mcd.cn',
          tool: 'list-nutrition-foods', productName: food.name, retrievedAt,
          priceMode: 'fictional-supply-points', physicsMode: 'game-design',
          availability: 'nutrition-catalog-only',
        },
      });
    } else unmatched.push(ammo.id);
  }
  return { matched, unmatched, foodCount: foods.length, retrievedAt, source: 'official-mcp-live', availability: 'nutrition-catalog-only' };
}
