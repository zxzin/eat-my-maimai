import { McdMcpConnection, McpError } from './mcd-mcp.js';

const MAX_BODY = 64 * 1024;
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function assertLocalRequest(req) {
  // The game may be served to LAN phones. Its credential bridge stays local,
  // including when a remote client forges a loopback Host header.
  if (!LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress)) {
    throw new McpError('forbidden-origin', 'MCP 连接仅可在运行游戏服务的电脑上操作。', 403);
  }
  let host;
  try { host = new URL(`http://${req.headers.host}`); }
  catch { throw new McpError('forbidden-origin', '仅允许本机游戏页面访问。', 403); }
  if (!LOOPBACK_NAMES.has(host.hostname) || host.username || host.password || host.pathname !== '/') {
    throw new McpError('forbidden-origin', '仅允许本机游戏页面访问。', 403);
  }
  const origin = req.headers.origin;
  if (origin && origin !== host.origin) throw new McpError('forbidden-origin', '仅允许同源游戏页面访问。', 403);
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new McpError('forbidden-origin', '仅允许同源游戏页面访问。', 403);
  if (req.method !== 'GET' && origin !== host.origin) throw new McpError('forbidden-origin', '请求缺少同源验证。', 403);
}

async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new McpError('invalid-content-type', '请求应使用 JSON。', 415);
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) throw new McpError('body-too-large', '请求内容过大。', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY) throw new McpError('body-too-large', '请求内容过大。', 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new McpError('invalid-json', '请求内容应为 JSON 对象。', 400); }
}

export function createMcpMiddleware(connection = new McdMcpConnection()) {
  return async (req, res, next) => {
    const path = req.url?.split('?')[0];
    if (!path?.startsWith('/api/mcp/')) return next();
    const send = (status, payload) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(JSON.stringify(payload));
    };
    try {
      assertLocalRequest(req);
      if (req.method === 'GET' && path === '/api/mcp/status') return send(200, connection.status());
      if (req.method !== 'POST') throw new McpError('method-not-allowed', '该接口不支持这个请求方式。', 405);
      const body = await readBody(req);
      if (path === '/api/mcp/connect') {
        if (body.token !== undefined && typeof body.token !== 'string') throw new McpError('invalid-token', 'Token 格式不正确。', 400);
        return send(200, await connection.connect(body.token));
      }
      if (path === '/api/mcp/disconnect') return send(200, connection.disconnect());
      if (path === '/api/mcp/nutrition') return send(200, await connection.call('list-nutrition-foods', body.arguments || {}));
      if (path === '/api/mcp/call') return send(200, await connection.call(body.name, body.arguments || {}));
      throw new McpError('not-found', '接口不存在。', 404);
    } catch (error) {
      const known = error instanceof McpError;
      send(known ? error.status : 500, {
        state: connection.status().state,
        error: { code: known ? error.code : 'internal-error', message: known ? error.message : '本地接入服务暂时不可用。' },
      });
    }
  };
}

export function mcpPlugin() {
  const connection = new McdMcpConnection();
  const mount = server => { server.middlewares.use(createMcpMiddleware(connection)); };
  return {
    name: 'angry-burgers-readonly-mcp',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
