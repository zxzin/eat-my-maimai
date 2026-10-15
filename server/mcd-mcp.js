export const MCP_ENDPOINT = 'https://mcp.mcd.cn';
export const READ_ONLY_TOOLS = Object.freeze([
  'list-nutrition-foods', 'query-nearby-stores', 'query-meals', 'query-meal-detail', 'calculate-price',
]);
const SUPPORTED_PROTOCOLS = ['2025-03-26', '2025-06-18', '2025-11-25'];
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// Store discovery uses an explicitly supplied city and public landmark. Favorites,
// coordinates, member cards and coupons are outside this game's query flow.
export function validateQueryScope(name, args) {
  if (name === 'query-nearby-stores' && (args.searchType !== 2 || args.beType !== 1
    || typeof args.city !== 'string' || !args.city.trim()
    || typeof args.keyword !== 'string' || !args.keyword.trim()
    || Object.keys(args).some(key => !['searchType', 'beType', 'city', 'keyword'].includes(key)))) {
    throw new McpError('query-scope', '门店查询使用城市、公开地标与到店自取方式。', 400);
  }
  const forbidden = new Set(['couponId', 'couponCode', 'withOrder', 'addressId', 'contactName', 'phone']);
  const visit = value => value && typeof value === 'object' && Object.entries(value).some(([key, entry]) => forbidden.has(key) || visit(entry));
  if (visit(args)) throw new McpError('query-scope', '游戏查询仅使用餐品与门店参数。', 400);
}

export class McpError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Upstream error bodies and headers stay private: they can contain account data.
async function readRpcResponse(response, id) {
  if (response.status === 401 || response.status === 403) {
    throw new McpError('needs-auth', '官方服务拒绝了认证，请检查 MCP Token。', 401);
  }
  if (response.status === 429) throw new McpError('rate-limited', '官方服务暂时限流，请稍后重试。', 429);
  if (!response.ok) throw new McpError('upstream-error', `官方服务返回 HTTP ${response.status}。`);
  if (id === undefined && (response.status === 202 || response.status === 204)) return null;
  if (!response.body) throw new McpError('invalid-response', '官方服务未返回有效数据。');

  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
  const accept = (value) => {
    const messages = Array.isArray(value) ? value : [value];
    return messages.find(message => message?.jsonrpc === '2.0' && message.id === id
      && ('result' in message || 'error' in message));
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new McpError('response-too-large', '官方响应超过本地读取上限。');
      buffer += decoder.decode(chunk.value, { stream: true });
      if (!sse) continue;
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = event.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (!payload) continue;
        let parsed;
        try { parsed = JSON.parse(payload); } catch { throw new McpError('invalid-response', '官方返回的数据格式无法解析。'); }
        const message = accept(parsed);
        if (message) return message;
      }
    }
    if (id === undefined && !buffer.trim()) return null;
    if (!sse) {
      let parsed;
      try { parsed = JSON.parse(buffer + decoder.decode()); } catch { throw new McpError('invalid-response', '官方返回的数据格式无法解析。'); }
      const message = accept(parsed);
      if (message) return message;
    }
    throw new McpError('invalid-response', '官方响应缺少对应的请求结果。');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Validate common JSON Schema constraints from the live tools/list response.
// The remote tool remains the authority for its complete business rules.
export function validateArguments(value, schema, root = schema, path = 'arguments') {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${path} 不被工具接受`];
  if (!schema || typeof schema !== 'object') return [`${path} 的工具格式无效`];
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) return [`${path} 使用暂不支持的外部 schema`];
    const referenced = schema.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    if (!referenced) return [`${path} 的 schema 引用无效`];
    return validateArguments(value, referenced, root, path);
  }
  if (schema.anyOf && !schema.anyOf.some(option => validateArguments(value, option, root, path).length === 0)) return [`${path} 不符合可选格式`];
  if (schema.oneOf && schema.oneOf.filter(option => validateArguments(value, option, root, path).length === 0).length !== 1) return [`${path} 不符合唯一格式`];
  const errors = (schema.allOf || []).flatMap(option => validateArguments(value, option, root, path));
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.includes(type) && !(types.includes('integer') && Number.isInteger(value))) return [`${path} 的类型应为 ${types.join('/')}`];
  if (schema.enum && !schema.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) errors.push(`${path} 不在允许选项中`);
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path} 不符合固定值`);
  if (type === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} 为必填项`);
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) errors.push(...validateArguments(entry, schema.properties[key], root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} 不属于工具参数`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...validateArguments(entry, schema.additionalProperties, root, `${path}.${key}`));
    }
  }
  if (type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} 数量不足`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} 数量过多`);
    value.forEach((entry, index) => errors.push(...validateArguments(entry, schema.items, root, `${path}[${index}]`)));
  }
  if (type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} 长度不足`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} 长度过长`);
    if (schema.pattern) {
      try { if (!new RegExp(schema.pattern).test(value)) errors.push(`${path} 格式不匹配`); }
      catch { errors.push(`${path} 的 schema 格式无效`); }
    }
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) errors.push(`${path} 应为有限数字`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} 低于允许范围`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} 超出允许范围`);
  }
  return errors;
}

export class McdMcpConnection {
  #token = '';
  #session = '';
  #nextId = 0;
  #busy = false;
  #protocol = '2025-03-26';
  constructor({ fetchImpl = fetch, getEnvironmentToken = () => process.env.MCD_TOKEN || '', timeoutMs = 15000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.getEnvironmentToken = getEnvironmentToken;
    this.timeoutMs = timeoutMs;
    this.state = 'needs-auth';
    this.message = '填入麦当劳 MCP Token 后连接官方餐品目录。';
    this.tools = [];
    this.connectedAt = null;
  }

  status() {
    return {
      state: this.state, message: this.message, endpoint: MCP_ENDPOINT,
      tools: this.tools, connectedAt: this.connectedAt,
      hasServerCredential: Boolean(this.getEnvironmentToken()), busy: this.#busy,
    };
  }

  async #rpc(method, params, notification = false) {
    const id = notification ? undefined : ++this.#nextId;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (this.#session) headers['Mcp-Session-Id'] = this.#session;
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = this.#protocol;
    let response;
    try {
      response = await this.fetchImpl(MCP_ENDPOINT, {
        method: 'POST', headers, redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const message = await readRpcResponse(response, id);
      if (message?.error) throw new McpError('rpc-error', '官方 MCP 拒绝了本次请求。');
      if (method === 'initialize') this.#session = response.headers.get('mcp-session-id') || '';
      return message?.result;
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError('unavailable', '暂时无法访问麦当劳 MCP，请检查网络后重试。', 503);
    }
  }

  async connect(providedToken) {
    if (this.#busy) throw new McpError('busy', '连接正在处理中，请稍候。', 409);
    const token = providedToken?.trim() || this.getEnvironmentToken();
    if (!token) throw new McpError('needs-auth', '请先填入自己的麦当劳 MCP Token。', 401);
    if (typeof token !== 'string' || token.length > 8192 || /[\r\n]/.test(token)) throw new McpError('invalid-token', 'Token 格式不正确。', 400);
    this.#busy = true;
    this.#token = token;
    this.#session = '';
    this.tools = [];
    this.connectedAt = null;
    try {
      const initialized = await this.#rpc('initialize', {
        protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'angry-burgers-readonly', version: '0.2.0' },
      });
      if (!SUPPORTED_PROTOCOLS.includes(initialized?.protocolVersion)) throw new McpError('unsupported-protocol', '官方返回了暂不支持的 MCP 版本。');
      this.#protocol = initialized.protocolVersion;
      await this.#rpc('notifications/initialized', undefined, true);
      const collected = [];
      let cursor;
      for (let page = 0; page < 10; page += 1) {
        const result = await this.#rpc('tools/list', cursor ? { cursor } : {});
        if (!Array.isArray(result?.tools)) throw new McpError('invalid-tools', '官方工具目录格式不正确。');
        for (const tool of result.tools) {
          if (READ_ONLY_TOOLS.includes(tool.name) && tool.inputSchema && typeof tool.inputSchema === 'object') {
            collected.push({ name: tool.name, description: String(tool.description || ''), inputSchema: tool.inputSchema });
          }
        }
        cursor = result.nextCursor;
        if (!cursor) break;
        if (page === 9) throw new McpError('too-many-tools', '官方工具目录超出本地读取上限。');
      }
      this.tools = collected.filter((tool, index) => collected.findIndex(other => other.name === tool.name) === index);
      this.state = 'connected';
      this.connectedAt = new Date().toISOString();
      this.message = '已连接麦当劳官方 MCP，可同步餐品目录。';
      this.#busy = false;
      return this.status();
    } catch (error) {
      this.state = error.code === 'needs-auth' ? 'needs-auth' : error.code === 'unavailable' ? 'unavailable' : 'error';
      this.message = error.message;
      this.#token = '';
      this.#session = '';
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async call(name, args = {}) {
    if (!READ_ONLY_TOOLS.includes(name)) throw new McpError('forbidden-tool', '本游戏仅开放餐品查询与核价工具。', 403);
    if (this.#busy) throw new McpError('busy', '上次请求正在处理中，请稍候。', 409);
    if (this.state !== 'connected') throw new McpError('needs-auth', '请先连接麦当劳 MCP。', 401);
    const tool = this.tools.find(entry => entry.name === name);
    if (!tool) throw new McpError('tool-unavailable', '当前官方目录未提供这个工具。', 404);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new McpError('invalid-arguments', '工具参数必须是对象。', 400);
    validateQueryScope(name, args);
    const errors = validateArguments(args, tool.inputSchema);
    if (errors.length) throw new McpError('invalid-arguments', errors.slice(0, 6).join('；'), 400);
    this.#busy = true;
    try {
      const result = await this.#rpc('tools/call', { name, arguments: args });
      if (result?.isError) throw new McpError('tool-error', '官方工具未能完成查询，请核对所选参数。');
      return { state: this.state, tool: name, result, retrievedAt: new Date().toISOString() };
    } catch (error) {
      if (error.code === 'needs-auth') {
        this.state = 'needs-auth';
        this.#token = '';
        this.#session = '';
        this.tools = [];
        this.connectedAt = null;
      }
      this.message = error.message;
      throw error;
    } finally { this.#busy = false; }
  }

  disconnect() {
    if (this.#busy) throw new McpError('busy', '请求正在处理中，请稍后断开。', 409);
    this.#token = '';
    this.#session = '';
    this.tools = [];
    this.connectedAt = null;
    this.state = 'needs-auth';
    this.message = '已断开连接，内存中的 Token 已清除。';
    return this.status();
  }
}
