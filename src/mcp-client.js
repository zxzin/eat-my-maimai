async function request(path, body) {
  let response;
  try {
    response = await fetch(`/api/mcp/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(60000),
    });
  } catch {
    const error = new Error('本地 MCP 服务暂时不可用，请通过本地游戏服务打开。');
    error.state = 'unavailable';
    throw error;
  }
  let data;
  try { data = await response.json(); } catch {
    const error = new Error('当前页面没有运行 MCP 接入服务。');
    error.state = 'unavailable';
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data.error?.message || 'MCP 请求未完成。');
    error.code = data.error?.code;
    error.state = data.state || 'error';
    throw error;
  }
  return data;
}

export const getMcpStatus = () => request('status');
export const connectMcp = token => request('connect', token ? { token } : {});
export const disconnectMcp = () => request('disconnect', {});
export const loadMcpNutrition = (args = {}) => request('nutrition', { arguments: args });
export const callMcpTool = (name, args = {}) => request('call', { name, arguments: args });
export const loadMcpStores = args => callMcpTool('query-nearby-stores', args);
export const loadMcpMenu = args => callMcpTool('query-meals', args);
export const loadMcpMealDetail = args => callMcpTool('query-meal-detail', args);
export const loadMcpQuote = args => callMcpTool('calculate-price', args);
