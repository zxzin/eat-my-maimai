import { getMcpStatus, connectMcp, disconnectMcp, loadMcpNutrition } from './mcp-client.js';
import { buildLiveLoadout } from './mcp-loadout.js';
import { PACKS } from './ingredient-rules.js';
import { setupMcpPriceUI } from './mcp-price-ui.js';
import publicSnapshot from './public-menu-snapshot.js';

const defaultApi = { getMcpStatus, connectMcp, disconnectMcp, loadMcpNutrition };
const $ = id => document.getElementById(id);

export function setupMcpUI({ onLive, onDemo, onMenu, getSelection, api = defaultApi, priceApi }) {
  let connected = false;
  let busy = false;
  let live = false;
  let revision = 0;
  let hasServerCredential = false;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  let priceBusy = false;
  const priceUI = onMenu ? setupMcpPriceUI({ onMenu, getSelection, api: priceApi,
    onBusyChange: value => { priceBusy = value; controls(); }, onConnectionError: failed,
  }) : null;
  let priceConnected = false;
  let credentialsConnected;
  if (onMenu && publicSnapshot.products.length) onMenu(publicSnapshot);

  function controls() {
    if (credentialsConnected !== connected) {
      const credentials = $('mcpCredentials'); if (credentials) credentials.open = !connected;
      credentialsConnected = connected;
    }
    priceUI?.setExternalBusy(busy);
    if (priceConnected !== (connected && local)) {
      priceConnected = connected && local;
      priceUI?.setConnected(priceConnected);
    }
    $('mcpSync').disabled = !connected || busy || priceBusy;
    $('mcpDisconnect').disabled = !connected || busy || priceBusy;
    $('mcpConnect').disabled = busy || priceBusy || !local;
  }
  function state(label, message) {
    $('mcpStatus').textContent = label;
    if (message) $('mcpMessage').textContent = message;
    controls();
  }
  function clearLive() {
    $('mcpFoods').replaceChildren();
    $('mcpFoods').hidden = true;
    $('mcpBadge').textContent = '连接麦当劳 MCP';
    $('dataButton').classList.remove('connected');
    if (live) onDemo();
    live = false;
  }
  function failed(error) {
    connected = error.state === 'connected';
    clearLive();
    if (error.code === 'needs-auth' || error.state === 'needs-auth') {
      connected = false;
      state('等待首次授权', `${error.message} 请在上方麦当劳官方授权页面登录并激活个人 Token。`);
    } else {
      state(connected ? '已连接 · 同步未完成' : '连接未完成', error.message || '请检查本地服务后重试。');
    }
  }
  async function sync() {
    const response = await api.loadMcpNutrition();
    const data = buildLiveLoadout(response.result, PACKS, response.retrievedAt);
    if (!data.matched.length) {
      clearLive();
      state('已连接 · 无可用配装', '官方返回的目录中暂未识别到可配装餐品，已使用演示模式。营养目录不代表门店库存。');
      return;
    }
    $('mcpFoods').replaceChildren();
    for (const item of data.matched) {
      const span = document.createElement('span');
      span.textContent = item.name;
      $('mcpFoods').append(span);
    }
    onLive(data.matched);
    live = true;
    $('mcpFoods').hidden = false;
    $('mcpBadge').textContent = `MCP 配装餐品 · ${data.matched.length} 款`;
    $('dataButton').classList.add('connected');
    state('官方餐品目录已同步', `刚刚读取官方餐品目录 ${data.foodCount} 项，匹配 ${data.matched.length} 款可配装餐品。本局已重置，使用本次同步结果。营养目录不代表门店库存。`);
    await priceUI?.refresh(data);
  }
  async function run(fn, reconnect = false) {
    if (busy || priceBusy) return;
    revision += 1;
    busy = true;
    if (reconnect) {
      connected = false;
      clearLive();
    }
    state('正在读取官方 MCP…');
    try { await fn(); }
    catch (error) { failed(error); }
    finally {
      busy = false;
      $('mcpToken').value = '';
      controls();
    }
  }

  $('mcpForm').addEventListener('submit', event => {
    event.preventDefault();
    const token = $('mcpToken').value.trim();
    // Clear before the first awaited operation so credentials do not linger.
    $('mcpToken').value = '';
    if (!local || busy || priceBusy) return;
    if (!token && !hasServerCredential) {
      if (connected) state('MCP 已连接', '可以重新同步餐品。更换连接时，请填入新的个人 Token。');
      else state('等待首次授权', '请先在上方麦当劳官方授权页面登录、激活并复制个人 Token，再填到输入框。');
      return;
    }
    return run(async () => {
      const status = await api.connectMcp(token || undefined);
      if (status.state !== 'connected') {
        const error = new Error(status.message || '官方连接尚未完成。');
        error.state = status.state;
        throw error;
      }
      connected = true;
      state('已连接 · 正在同步');
      await sync();
    }, true);
  });
  $('mcpSync').addEventListener('click', () => {
    if (connected && local) return run(sync);
  });
  $('mcpDisconnect').addEventListener('click', () => {
    if (!connected || !local) return;
    return run(async () => {
      await api.disconnectMcp();
      connected = false;
      clearLive();
      state('已断开 · 演示模式', '本机服务内存中的 Token 已清除。再次连接可使用上方麦当劳官方授权入口。');
    });
  });

  if (!local) {
    state('手机试玩 · 演示模式', '此局域网页面可直接玩。首次 MCP 授权请在电脑的 localhost 游戏页完成，个人 Token 仅供本机连接。');
    $('mcpToken').disabled = true;
    return { ready: Promise.resolve() };
  }
  const initialRevision = revision;
  const ready = api.getMcpStatus().then(data => {
    // A slow initial status must not overwrite a newer user-initiated action.
    if (revision !== initialRevision) return;
    connected = data.state === 'connected';
    hasServerCredential = Boolean(data.hasServerCredential);
    const label = connected ? 'MCP 已连接 · 可同步餐品'
      : data.state === 'needs-auth' ? '等待首次授权'
        : data.state === 'unavailable' ? '官方连接暂时不可用' : '连接未完成';
    state(label, data.message);
  }).catch(error => {
    if (revision === initialRevision) failed(error);
  });
  return { ready };
}
