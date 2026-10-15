import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const SINGLE_HTML_NAME = '吃我一发麦麦.html';

export function escapeInlineScript(source) {
  return source.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

// Read a deliberately public export, never an account file or a raw MCP reply.
export function sanitizePublicSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const text = (value, limit = 120) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000 ? Math.round(value * 100) / 100 : null;
  const seen = new Set();
  const products = (Array.isArray(input.products) ? input.products : []).slice(0, 500).flatMap(product => {
    if (!product || typeof product !== 'object') return [];
    const packId = text(product.packId, 40), name = text(product.name);
    if (!/^[a-z0-9_-]{1,40}$/.test(packId) || !name || seen.has(packId)) return [];
    seen.add(packId);
    return [{ packId, code: text(product.code, 64), name, publicPriceYuan: amount(product.publicPriceYuan), originalPriceYuan: amount(product.originalPriceYuan), priceSource: text(product.priceSource, 64) }];
  });
  const matchedIds = [...new Set((Array.isArray(input.nutrition?.matchedIds) ? input.nutrition.matchedIds : [])
    .filter(id => typeof id === 'string' && /^[a-z0-9_-]{1,40}$/.test(id)))].slice(0, 50);
  if (!products.length && !matchedIds.length) return null;
  return {
    schemaVersion: 1,
    source: 'official-mcp-public-snapshot',
    retrievedAt: date(input.retrievedAt),
    store: { code: text(input.store?.code, 64), name: text(input.store?.name), city: text(input.store?.city), address: text(input.store?.address, 240) },
    nutrition: { retrievedAt: date(input.nutrition?.retrievedAt), foodCount: Number.isSafeInteger(input.nutrition?.foodCount) && input.nutrition.foodCount >= 0 && input.nutrition.foodCount <= 10000 ? input.nutrition.foodCount : null, matchedIds },
    products,
  };
}

export function offlineDataDialog() {
  return `<dialog id="dataDialog" class="game-dialog data-dialog">
    <button class="dialog-close" type="button" data-close aria-label="关闭餐品说明">×</button>
    <span class="dialog-eyebrow">MENU → AMMO</span><h2>开饭，随时开战。</h2>
    <div class="data-status"><span class="status-dot"></span><strong id="mcpStatus">离线试玩</strong></div>
    <p id="mcpMessage" role="status" aria-live="polite">完整游戏已装进这一页，打开就能玩。</p>
    <div id="mcpFoods" class="mcp-foods" hidden></div>
    <p class="data-note">餐品与参考价使用打包时的公开快照，实际售价以门店为准。金币、食材份额与技能为游戏设定。所有购买均发生在本局游戏内。</p>
    <button class="primary-button" type="button" data-close>回到配餐台</button>
  </dialog>`;
}

export function renderSingleHtml(template, javascript, stylesheet, snapshot = null, licenseText = '') {
  if (!/<dialog\b[^>]*\bid="dataDialog"[\s\S]*?<\/dialog>/i.test(template)) {
    throw new Error('单页构建需要 dataDialog 餐品说明入口。');
  }
  let html = template
    .replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b(?=[^>]*\brel=["'](?:stylesheet|modulepreload|preload)["'])[^>]*>/gi, '')
    .replace(/<dialog\b[^>]*\bid="dataDialog"[\s\S]*?<\/dialog>/i, offlineDataDialog())
    .replace('<head>', `<head>
  <meta name="maimai-build" content="single-html-offline" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; worker-src blob:; base-uri 'none'; form-action 'none'" />`);
  if (/<\/(?:style)/i.test(stylesheet)) throw new Error('样式包含无法安全内联的结束标签。');
  if (/<(?:script|link|img|audio|video|source)\b[^>]*(?:src|href)=["'](?!data:|#)[^"']+["']/i.test(html)) {
    throw new Error('单 HTML 仍引用外部运行资源。');
  }
  if (/url\(\s*["']?(?!data:|#)[^\s)"']+/i.test(stylesheet)) throw new Error('样式仍引用外部运行资源。');
  html = html.replace('</head>', `<style>${stylesheet}</style>\n</head>`);
  if (licenseText) html = html.replace('</head>', `<!--\nTHIRD-PARTY LICENSE — three.js\n${licenseText.replace(/--/g, '—')}\n-->\n</head>`);
  const data = escapeInlineScript(JSON.stringify(snapshot));
  const boot = `window.__MAIMAI_PUBLIC_SNAPSHOT__=${data};\n${javascript}`;
  html = html.replace('</body>', `<script>${escapeInlineScript(boot)}</script>\n</body>`);
  if (/\bid=["']mcpToken["']|\btype=["']password["']|\/api\/mcp\//i.test(html)) {
    throw new Error('离线产物仍包含账号输入或 MCP API 路径；请先接入 __SINGLE_HTML__ 离线分支。');
  }
  return html;
}

export async function buildSingleHtml({ root = projectRoot, outDir = path.join(root, 'release-single'), snapshotPath } = {}) {
  const publicPath = snapshotPath || path.join(root, 'public', 'menu-snapshot.json');
  let snapshot = null;
  try {
    const raw = await fs.readFile(publicPath, 'utf8');
    if (raw.length > 1024 * 1024) throw new Error('公开餐品快照超过 1 MiB。');
    snapshot = sanitizePublicSnapshot(JSON.parse(raw));
    if (!snapshot) throw new Error('公开餐品快照缺少可用餐品或营养目录匹配信息。');
  } catch (error) {
    if (error.code !== 'ENOENT' || snapshotPath) throw error;
  }
  const result = await build({
    configFile: false,
    root,
    publicDir: false,
    // The standalone target links the same UI entry to its offline implementation.
    // Account tooling never enters this bundle, even if the live UI gains features.
    plugins: [{
      name: 'maimai-offline-connection',
      enforce: 'pre',
      resolveId(source, importer) {
        if (importer && source === './mcp-ui.js' && path.resolve(path.dirname(importer), source) === path.join(root, 'src', 'mcp-ui.js')) {
          return '\0maimai-offline-connection';
        }
      },
      load(id) {
        if (id === '\0maimai-offline-connection') return `export { setupSingleHtmlUI as setupMcpUI } from ${JSON.stringify(path.join(root, 'src', 'single-html-ui.js'))};`;
      },
    }],
    logLevel: 'warn',
    define: { __SINGLE_HTML__: 'true', 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      target: 'es2022',
      minify: 'esbuild',
      cssMinify: true,
      cssCodeSplit: false,
      assetsInlineLimit: Infinity,
      sourcemap: false,
      reportCompressedSize: false,
      lib: { entry: path.join(root, 'src/main.js'), name: 'MaimaiFoodFight', formats: ['iife'], fileName: 'game' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
  const chunks = outputs.filter(item => item.type === 'chunk');
  const styles = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  const extra = outputs.filter(item => item.type === 'asset' && !item.fileName.endsWith('.css'));
  if (chunks.length !== 1 || extra.length) throw new Error(`期望一个完整脚本，发现 ${chunks.length} 个脚本与 ${extra.length} 个未内联资产。`);
  if (chunks[0].imports.length || chunks[0].dynamicImports.length) throw new Error('单 HTML 包仍包含外部模块。');
  const template = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  const license = await fs.readFile(path.join(root, 'node_modules', 'three', 'LICENSE'), 'utf8');
  const html = renderSingleHtml(template, chunks[0].code, styles.map(style => String(style.source)).join('\n'), snapshot, license);
  await fs.mkdir(outDir, { recursive: true });
  const outputPath = path.join(outDir, SINGLE_HTML_NAME);
  await fs.writeFile(outputPath, html);
  const receipt = {
    builtAt: new Date().toISOString(),
    file: SINGLE_HTML_NAME,
    sha256: createHash('sha256').update(html).digest('hex'),
    bytes: Buffer.byteLength(html),
    gzipBytes: gzipSync(html).byteLength,
    javascriptBytes: Buffer.byteLength(chunks[0].code),
    cssBytes: styles.reduce((sum, style) => sum + Buffer.byteLength(style.source), 0),
    snapshot: snapshot ? { retrievedAt: snapshot.retrievedAt, store: snapshot.store, productCount: snapshot.products.length } : null,
    runtimeAssets: 'all-inline',
    liveMcp: false,
    credentialInputs: false,
  };
  await fs.writeFile(path.join(outDir, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { outputPath, ...receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some((arg, index) => !['--snapshot', '--out-dir'].includes(arg) && (index === 0 || !['--snapshot', '--out-dir'].includes(args[index - 1])))) {
    throw new Error('用法：node scripts/build-single-html.mjs [--snapshot public/menu-snapshot.json] [--out-dir release-single]');
  }
  const option = name => { const index = args.indexOf(name); return index >= 0 ? path.resolve(args[index + 1] || '') : undefined; };
  console.log(JSON.stringify(await buildSingleHtml({ snapshotPath: option('--snapshot'), outDir: option('--out-dir') }), null, 2));
}
