import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { sanitizePublicSnapshot, buildSingleHtml } from './build-single-html.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// Each public file is named here. New runtime modules must enter this list
// deliberately; local prototypes, receipts and account files stay outside it.
export const PUBLIC_FILES = Object.freeze([
  'README.md', 'PRODUCT.md', 'CONTEST_DECLARATION.md', 'MCP_INTEGRATION.md',
  'THIRD_PARTY_NOTICES.md', 'LICENSE', 'mcp-config.example.json',
  'package.json', 'package-lock.json', 'index.html', 'vite.config.js',
  'src/main.js', 'src/style.css', 'src/food-models.js', 'src/ingredient-models.js',
  'src/ingredient-rules.js', 'src/economy.js', 'src/impact-fx.js',
  'src/plaza-environment.js', 'src/display-resolution.js', 'src/fire-control.js', 'src/game-guide.js',
  'src/building-damage.js', 'src/combat-feedback.js', 'src/restaurant-stage.js', 'src/stage-rules.js',
  'src/mcp-client.js', 'src/mcp-loadout.js', 'src/mcp-menu.js',
  'src/mcp-price-ui.js', 'src/mcp-ui.js', 'src/public-menu-snapshot.js',
  'src/single-html-ui.js', 'server/mcd-mcp.js', 'server/mcp-vite-plugin.js',
  'scripts/build-single-html.mjs', 'scripts/single-html-check.mjs', 'scripts/sync-public-menu.mjs',
  'scripts/guide-flow-check.mjs', 'scripts/render-resolution-check.mjs', 'scripts/corn-fire-check.mjs',
  'scripts/building-check.mjs', 'scripts/shooter-check.mjs', 'scripts/economy-check.mjs', 'scripts/ui-checks.mjs', 'scripts/package-github.mjs',
  'tests/display-resolution.test.mjs', 'tests/fire-control.test.mjs', 'tests/game-guide.test.mjs',
  'tests/ingredient-rules.test.mjs', 'tests/economy.test.mjs',
  'tests/impact-fx.test.mjs', 'tests/mcp.test.mjs', 'tests/mcp-menu.test.mjs',
  'tests/building-damage.test.mjs', 'tests/combat-feedback.test.mjs', 'tests/stage-rules.test.mjs', 'tests/restaurant-stage.test.mjs',
  'tests/mcp-toon.test.mjs', 'tests/mcp-ui.test.mjs', 'tests/single-html.test.mjs',
  'docs/SOURCES.md', 'docs/CONTEST_CHECKLIST.md', 'docs/XIAOHONGSHU_DRAFT.md',
  'docs/screenshots/gameplay.png', 'docs/screenshots/mobile.png',
]);
const OPTIONAL_PUBLIC_FILES = Object.freeze([
  'public/menu-snapshot.json', 'tests/mcp-price-ui.test.mjs',
  'tests/public-menu-snapshot.test.mjs',
]);
const GENERATED_FILES = ['.gitignore', 'PUBLIC_FILES.json', 'docs/index.html', 'docs/.nojekyll'];
const IGNORE = `node_modules/\ndist/\n.env\n.env.*\n!.env.example\nartifacts/\nrelease-github/\nrelease-single/\n*.log\n.DS_Store\n`;
const forbiddenSegments = new Set(['node_modules', 'dist', 'artifacts', 'experiments', '.git']);
const sha256 = data => createHash('sha256').update(data).digest('hex');

async function regularFile(base, relative) {
  const file = path.resolve(base, relative);
  if (!file.startsWith(path.resolve(base) + path.sep)) throw new Error(`Public path escapes source root: ${relative}`);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Public source must be a regular file: ${relative}`);
  return file;
}

async function walk(base, directory = '') {
  const entries = await fs.readdir(path.join(base, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!directory && entry.name === '.git' && entry.isDirectory()) continue;
    const relative = path.posix.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Public output contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) files.push(...await walk(base, relative));
    else files.push(relative);
  }
  return files;
}

function verifyImports(files) {
  const available = new Set(files.keys());
  for (const [relative, data] of files) {
    if (!/\.(?:js|mjs)$/.test(relative)) continue;
    const text = data.toString('utf8');
    const imports = text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g);
    for (const [, specifier] of imports) {
      const imported = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      if (!available.has(imported)) throw new Error(`Public package misses ${imported}, imported by ${relative}`);
    }
  }
}

export async function packageGithub({ sourceRoot = root, outDir = path.join(sourceRoot, 'release-github') } = {}) {
  const resolvedRoot = path.resolve(sourceRoot), destination = path.resolve(outDir);
  if (destination === resolvedRoot || resolvedRoot.startsWith(destination + path.sep)) {
    throw new Error('Public output must be a dedicated directory below or beside the project.');
  }
  const selected = [...PUBLIC_FILES];
  for (const relative of OPTIONAL_PUBLIC_FILES) {
    try { await regularFile(resolvedRoot, relative); selected.push(relative); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const files = new Map();
  for (const relative of selected.sort()) {
    if (relative.split('/').some(segment => forbiddenSegments.has(segment)) || /(^|\/)\.env(?:\.|$)/.test(relative)) {
      throw new Error(`Forbidden public path: ${relative}`);
    }
    const original = await fs.readFile(await regularFile(resolvedRoot, relative));
    let data = original;
    if (relative === 'public/menu-snapshot.json') {
      const snapshot = sanitizePublicSnapshot(JSON.parse(data));
      if (!snapshot) throw new Error('Public snapshot has no valid public menu content.');
      data = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n');
    }
    files.set(relative, data);
  }
  verifyImports(files);
  const singleHtml = await buildSingleHtml({ root: resolvedRoot });
  files.set('docs/index.html', await fs.readFile(singleHtml.outputPath));
  files.set('docs/.nojekyll', Buffer.from(''));
  const config = JSON.parse(files.get('mcp-config.example.json'));
  if (config.mcpServers?.['mcd-mcp']?.headers?.Authorization !== 'Bearer ${MCD_TOKEN}') {
    throw new Error('The public MCP config must retain the MCD_TOKEN environment placeholder.');
  }
  const declaration = files.get('CONTEST_DECLARATION.md');
  const declarationBlob = createHash('sha1').update(`blob ${declaration.length}\0`).update(declaration).digest('hex');
  if (declarationBlob !== '136e76f3160317049f19f5ba03f4d0fedd70fc3c') {
    throw new Error('Contest declaration differs from the official file verified on 2026-10-15. Reverify it before packaging.');
  }
  await fs.mkdir(destination, { recursive: true });
  const allowed = new Set([...files.keys(), ...GENERATED_FILES]);
  for (const existing of await walk(destination)) {
    if (!allowed.has(existing)) throw new Error(`Public output contains an unexpected file; inspect it before packaging: ${existing}`);
  }
  // Keep an empty public directory so the browser checks have a stable source
  // root even when no optional public snapshot has been exported yet.
  await fs.mkdir(path.join(destination, 'public'), { recursive: true });
  files.set('.gitignore', Buffer.from(IGNORE));
  for (const [relative, data] of files) {
    const output = path.join(destination, relative);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, data);
  }
  const manifest = {
    format: 'maimai-public-source-package',
    preparedAt: new Date().toISOString(),
    publication: 'local-only',
    files: [...files].map(([file, data]) => ({ file, bytes: data.length, sha256: sha256(data) })),
    excluded: ['dependencies', 'build outputs', 'local receipts', 'credentials', 'unused prototypes'],
  };
  await fs.writeFile(path.join(destination, 'PUBLIC_FILES.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { directory: path.basename(destination), files: files.size + 1, bytes: [...files.values()].reduce((sum, data) => sum + data.length, 0), publication: manifest.publication };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 2) throw new Error('Usage: node scripts/package-github.mjs');
  console.log(JSON.stringify(await packageGithub(), null, 2));
}
