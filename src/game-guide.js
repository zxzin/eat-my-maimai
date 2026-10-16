export const GUIDE_STORAGE_KEY = 'maimai-guide-v1';
export const GUIDE_STEPS = Object.freeze([
  Object.freeze({ id: 'select', counter: '02/04', title: '先切回玉米，练练手', body: '点下方「玉米粒」，再按住战场。' }),
  Object.freeze({ id: 'fire', counter: '02/04', title: '长按玉米，扫起来！', body: '按住开火，拖动瞄准；8 粒击碎。' }),
  Object.freeze({ id: 'combine', counter: '03/04', title: '换同类食材，一发连消', body: '点下方食材，对准同类再开火。' }),
  Object.freeze({ id: 'mechanism', counter: '04/04', title: '瞄准金环，启动机关！', body: '同类弹药，击中金环里的食材。' }),
]);

export function initialGuideState({ ammoId = null, cornAvailable = true } = {}) {
  return { status: 'active', stage: 'battle', step: cornAvailable ? (ammoId === 'corn' ? 1 : 0) : 2, ammoId, combined: false, mechanism: false };
}

function nextAfterFire(state) {
  if (state.combined && state.mechanism) return { ...state, status: 'completed' };
  return { ...state, step: state.combined ? 3 : 2 };
}

/** Each teaching step follows a real action; useful actions performed early also count. */
export function advanceGuide(state, name, payload = {}) {
  if (state.status !== 'active') return state;
  if (name === 'skip') return { ...state, status: 'skipped' };
  if (state.stage === 'prep') return state;
  const ammoId = Object.hasOwn(payload, 'ammoId') ? payload.ammoId : state.ammoId;
  if (name === 'ammo-selected') return { ...state, ammoId, step: state.step < 2 ? (ammoId === 'corn' ? 1 : 0) : state.step };
  if (name === 'setpiece') {
    const demonstrated = { ...state, ammoId, mechanism: true };
    return state.step >= 2 ? nextAfterFire(demonstrated) : demonstrated;
  }
  if (state.step === 1 && name === 'shot' && ammoId === 'corn' && payload.continuous === true) return nextAfterFire({ ...state, ammoId });
  const matched = ammoId && !['corn', 'burgerbomb'].includes(ammoId) && ['cleared', 'damage'].includes(name) && ['match', 'combo'].includes(payload.kind);
  if (matched) {
    const demonstrated = { ...state, ammoId, combined: true };
    return state.step >= 2 ? nextAfterFire(demonstrated) : demonstrated;
  }
  return state;
}

/**
 * prepare() shows the compact menu step; start() follows the existing paid start action.
 * getTarget receives prep/select/fire/combine/mechanism. This guide never changes inventory.
 * Storage contains only a completed/skipped marker, with no gameplay history.
 */
export function createGameGuide({ root, prepRoot = null, getTarget = () => null, storage, storageKey = GUIDE_STORAGE_KEY } = {}) {
  if (!root) throw new TypeError('Game guide requires its root element');
  const view = root.ownerDocument.defaultView;
  if (storage === undefined) { try { storage = view.localStorage; } catch { storage = null; } }
  let state = { status: 'idle', stage: 'prep', step: 0, ammoId: null, combined: false, mechanism: false }, target = null, renderedStep = null;
  const counter = root.querySelector('[data-guide-step]');
  const title = root.querySelector('[data-guide-title]');
  const body = root.querySelector('[data-guide-body]');
  const skips = [root.querySelector('[data-guide-skip]'), prepRoot?.querySelector('[data-guide-skip]')].filter(Boolean);
  const stored = () => { try { return storage?.getItem(storageKey); } catch { return null; } };
  const remember = status => { try { storage?.setItem(storageKey, status); } catch { /* A blocked store keeps the guide usable for this session. */ } };
  const clearTarget = () => { target?.classList.remove('is-guide-target'); target = null; };
  const terminal = () => state.status === 'active' ? null : (['completed', 'skipped'].includes(state.status) ? state.status : (['completed', 'skipped'].includes(stored()) ? stored() : null));
  function render() {
    clearTarget();
    root.hidden = state.status !== 'active' || state.stage !== 'battle';
    if (prepRoot) prepRoot.hidden = state.status !== 'active' || state.stage !== 'prep';
    if (state.status !== 'active') return;
    if (state.stage === 'prep') {
      target = getTarget('prep') ?? null;
    } else {
      const step = GUIDE_STEPS[state.step];
      root.dataset.step = step.id;
      if (renderedStep !== state.step) {
        counter.textContent = step.counter;
        title.textContent = step.title;
        body.textContent = step.body;
        renderedStep = state.step;
      }
      target = getTarget(step.id) ?? null;
    }
    if (target?.tagName !== 'CANVAS') target?.classList.add('is-guide-target');
  }
  function refresh({ ammoId = state.ammoId, cornAvailable = true } = {}) {
    if (state.status === 'active' && state.stage === 'battle') {
      state = advanceGuide(state, 'ammo-selected', { ammoId });
      if (!cornAvailable && state.step < 2) state = nextAfterFire({ ...state, step: 2 });
      if (state.status === 'completed') remember(state.status);
    }
    render(); return { ...state };
  }
  function prepare({ force = false } = {}) {
    const status = force ? null : terminal();
    if (status) state = { ...state, status, stage: 'prep' };
    else if (force || state.status !== 'active') state = { ...initialGuideState(), stage: 'prep' };
    else state = { ...state, stage: 'prep' };
    render(); return { ...state };
  }
  function start({ force = false, ammoId = null, cornAvailable = true } = {}) {
    const status = force ? null : terminal();
    if (status) state = { ...state, status, stage: 'battle' };
    else if (!force && state.status === 'active') {
      state = { ...state, stage: 'battle' };
      return refresh({ ammoId, cornAvailable });
    } else state = initialGuideState({ ammoId, cornAvailable });
    render(); return { ...state };
  }
  function event(name, payload = {}) {
    const previous = state;
    state = advanceGuide(state, name, payload);
    if (state.status !== previous.status && ['completed', 'skipped'].includes(state.status)) remember(state.status);
    render(); return { ...state };
  }
  const onSkip = () => event('skip');
  for (const skip of skips) skip.addEventListener('click', onSkip);
  root.hidden = true;
  if (prepRoot) prepRoot.hidden = true;
  return {
    prepare, start, event, refresh,
    reset: options => { try { storage?.removeItem(storageKey); } catch { /* Reset still applies in this session. */ } state = { status: 'idle', stage: 'prep', step: 0, ammoId: null, combined: false, mechanism: false }; return options?.stage === 'prep' ? prepare({ force: true }) : start({ ...options, force: true }); },
    destroy: () => { clearTarget(); for (const skip of skips) skip.removeEventListener('click', onSkip); root.hidden = true; if (prepRoot) prepRoot.hidden = true; },
    get state() { return { ...state }; },
  };
}
