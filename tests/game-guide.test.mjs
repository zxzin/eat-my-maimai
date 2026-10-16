import test from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE_STORAGE_KEY, initialGuideState, advanceGuide, createGameGuide } from '../src/game-guide.js';

const cornShot = state => advanceGuide(state, 'shot', { ammoId: 'corn', continuous: true });
const match = state => advanceGuide(state, 'cleared', { ammoId: 'bun', kind: 'match' });

test('the guide requires continuous fire, a real ingredient clear and a mechanism', () => {
  let state = initialGuideState();
  state = advanceGuide(state, 'ammo-selected', { ammoId: 'bun' });
  assert.equal(state.step, 0);
  state = advanceGuide(state, 'ammo-selected', { ammoId: 'corn' });
  assert.equal(state.step, 1);
  state = advanceGuide(state, 'shot', { ammoId: 'corn', continuous: false });
  assert.equal(state.step, 1);
  state = cornShot(state);
  assert.equal(state.step, 2);
  state = advanceGuide(state, 'cleared', { ammoId: 'corn' });
  assert.equal(state.step, 2);
  state = match(state);
  assert.equal(state.step, 3);
  assert.equal(state.status, 'active');
  state = advanceGuide(state, 'setpiece');
  assert.equal(state.status, 'completed');
});

test('a mechanism triggered during combination completes both demonstrated steps', () => {
  let state = cornShot(initialGuideState({ ammoId: 'corn' }));
  state = advanceGuide(state, 'cleared', { ammoId: 'nugget', kind: 'match' });
  state = advanceGuide(state, 'setpiece', { ammoId: 'nugget' });
  assert.equal(state.status, 'completed');
  assert.equal(state.combined, true);
  assert.equal(state.mechanism, true);
});

test('successful actions performed early are retained until continuous fire is learned', () => {
  let state = initialGuideState({ ammoId: 'bun' });
  state = match(state);
  assert.equal(state.step, 0);
  state = advanceGuide(state, 'ammo-selected', { ammoId: 'corn' });
  state = cornShot(state);
  assert.equal(state.step, 3);
  let earlyMechanism = advanceGuide(initialGuideState({ ammoId: 'corn' }), 'setpiece');
  assert.equal(earlyMechanism.status, 'active');
  assert.equal(cornShot(earlyMechanism).step, 2);
  assert.equal(match(cornShot(earlyMechanism)).status, 'completed');
});

test('skip is terminal and unrelated actions preserve the current step', () => {
  const active = initialGuideState();
  assert.equal(advanceGuide(active, 'shop-open'), active);
  const skipped = advanceGuide(active, 'skip');
  assert.equal(skipped.status, 'skipped');
  assert.equal(advanceGuide(skipped, 'ammo-selected', { ammoId: 'corn' }), skipped);
  assert.equal(active.status, 'active');
});

test('switching from corn returns to selection until a real continuous shot', () => {
  let state = initialGuideState({ ammoId: 'corn' });
  state = advanceGuide(state, 'ammo-selected', { ammoId: 'bun' });
  assert.equal(state.step, 0);
  state = advanceGuide(state, 'shot', { ammoId: 'bun', continuous: true });
  assert.equal(state.step, 0);
  state = advanceGuide(state, 'ammo-selected', { ammoId: 'corn' });
  state = cornShot(state);
  state = advanceGuide(state, 'ammo-selected', { ammoId: 'nugget' });
  assert.equal(state.step, 2);
});

function guideFixture({ storage = null } = {}) {
  const element = tagName => {
    const classes = new Set(), events = new Map();
    return { tagName, textContent: '', classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) }, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name), click: () => events.get('click')?.() };
  };
  const parts = Object.fromEntries(['step', 'title', 'body', 'skip'].map(name => [`[data-guide-${name}]`, element('SPAN')]));
  const prepParts = Object.fromEntries(['step', 'title', 'body', 'skip'].map(name => [`[data-guide-${name}]`, element('SPAN')]));
  const corn = element('BUTTON'), canvas = element('CANVAS'), tray = element('DIV'), start = element('BUTTON'), goals = element('DIV');
  const root = { dataset: {}, hidden: true, ownerDocument: { defaultView: {} }, querySelector: selector => parts[selector] };
  const prepRoot = { hidden: true, querySelector: selector => prepParts[selector] };
  const guide = createGameGuide({ root, prepRoot, storage, getTarget: step => ({ prep: start, select: corn, fire: canvas, combine: tray, mechanism: goals })[step] });
  return { guide, root, prepRoot, parts, prepParts, corn, tray, start, goals };
}

test('preparation guidance highlights the actual start action and transfers cleanly into battle', () => {
  const { guide, root, prepRoot, start, parts } = guideFixture();
  guide.prepare();
  assert.equal(guide.state.stage, 'prep');
  assert.equal(prepRoot.hidden, false); assert.equal(root.hidden, true);
  assert.equal(start.classList.contains('is-guide-target'), true);
  const before = guide.state;
  guide.event('shot', { ammoId: 'corn', continuous: true });
  assert.deepEqual(guide.state, before);
  guide.start({ ammoId: 'corn' });
  assert.equal(guide.state.stage, 'battle');
  assert.equal(prepRoot.hidden, true); assert.equal(root.hidden, false);
  assert.equal(parts['[data-guide-step]'].textContent, '02/04');
  assert.equal(start.classList.contains('is-guide-target'), false);
  guide.destroy();
});

test('guide displays the four-stage counters and highlights each next real control', () => {
  const { guide, root, parts, corn, tray, goals } = guideFixture();
  guide.start({ ammoId: 'corn' });
  guide.event('ammo-selected', { ammoId: 'bun' });
  assert.equal(root.dataset.step, 'select'); assert.equal(parts['[data-guide-step]'].textContent, '02/04');
  assert.equal(corn.classList.contains('is-guide-target'), true);
  guide.start({ ammoId: 'corn' });
  assert.equal(corn.classList.contains('is-guide-target'), false);
  guide.event('shot', { ammoId: 'corn', continuous: true });
  assert.equal(parts['[data-guide-step]'].textContent, '03/04');
  assert.equal(tray.classList.contains('is-guide-target'), true);
  guide.event('cleared', { ammoId: 'bun', kind: 'match' });
  assert.equal(parts['[data-guide-step]'].textContent, '04/04');
  assert.equal(goals.classList.contains('is-guide-target'), true);
  assert.equal(tray.classList.contains('is-guide-target'), false);
  guide.event('setpiece');
  assert.equal(root.hidden, true);
  assert.equal(goals.classList.contains('is-guide-target'), false);
  guide.destroy();
});

test('empty corn skips directly to combinations while preserving learned actions', () => {
  const { guide, root, corn, tray } = guideFixture();
  guide.start({ ammoId: 'bun', cornAvailable: false });
  assert.equal(guide.state.step, 2);
  assert.equal(root.dataset.step, 'combine');
  assert.equal(corn.classList.contains('is-guide-target'), false);
  assert.equal(tray.classList.contains('is-guide-target'), true);
  guide.event('cleared', { ammoId: 'bun', kind: 'match' });
  assert.equal(guide.state.step, 3);
  guide.start({ force: true, ammoId: 'nugget', cornAvailable: false });
  assert.equal(guide.state.step, 2);
  assert.equal(guide.state.combined, false);
  guide.destroy();
});

test('refresh skips unavailable corn and terminal guides stay hidden', () => {
  const { guide, root, corn } = guideFixture();
  guide.start({ ammoId: 'bun' });
  guide.refresh({ ammoId: 'patty', cornAvailable: false });
  assert.equal(guide.state.step, 2);
  assert.equal(corn.classList.contains('is-guide-target'), false);
  guide.refresh({ ammoId: 'corn', cornAvailable: true });
  assert.equal(guide.state.step, 2);
  guide.event('cleared', { ammoId: 'bun', kind: 'match' });
  guide.event('setpiece');
  const completed = guide.state;
  guide.refresh({ ammoId: 'bun', cornAvailable: false });
  assert.deepEqual(guide.state, completed);
  assert.equal(root.hidden, true);
  guide.destroy();
});

test('returning to preparation preserves progress and explicit replay resets the demonstration', () => {
  const { guide, root, prepRoot } = guideFixture();
  guide.start({ ammoId: 'corn' });
  guide.event('shot', { ammoId: 'corn', continuous: true });
  guide.prepare();
  assert.equal(guide.state.stage, 'prep'); assert.equal(guide.state.step, 2);
  assert.equal(root.hidden, true); assert.equal(prepRoot.hidden, false);
  guide.start({ ammoId: 'bun' });
  assert.equal(guide.state.step, 2);
  guide.prepare({ force: true });
  assert.equal(guide.state.stage, 'prep'); assert.equal(guide.state.step, 0);
  guide.start({ ammoId: 'corn' });
  assert.equal(guide.state.step, 1);
  guide.destroy();
});

test('only completion and skip persist; a fresh guide respects markers and can replay', () => {
  const values = new Map(), writes = [];
  const storage = { getItem: key => values.get(key), setItem: (key, value) => { values.set(key, value); writes.push(value); } };
  const first = guideFixture({ storage });
  first.guide.prepare(); first.guide.start({ ammoId: 'corn' });
  first.guide.event('shot', { ammoId: 'corn', continuous: true });
  assert.deepEqual(writes, []);
  first.guide.event('cleared', { ammoId: 'nugget', kind: 'match' });
  first.guide.event('setpiece');
  assert.deepEqual(writes, ['completed']);
  assert.equal(values.get(GUIDE_STORAGE_KEY), 'completed');
  const returning = guideFixture({ storage });
  returning.guide.prepare();
  assert.equal(returning.prepRoot.hidden, true);
  returning.guide.prepare({ force: true });
  assert.equal(returning.prepRoot.hidden, false);
  returning.guide.prepare();
  returning.guide.start({ ammoId: 'corn' });
  assert.equal(returning.root.hidden, false);
  assert.equal(returning.guide.state.step, 1);
  returning.guide.prepare();
  returning.prepParts['[data-guide-skip]'].click();
  assert.equal(returning.guide.state.status, 'skipped');
  assert.deepEqual(writes, ['completed', 'skipped']);
  assert.equal(returning.prepRoot.hidden, true);
  first.guide.destroy(); returning.guide.destroy();
});


test('corn-triggered mechanisms and bomb clears keep the same-ingredient lesson active', () => {
  let state = cornShot(initialGuideState({ ammoId: 'corn' }));
  state = advanceGuide(state, 'cleared', { ammoId: 'corn', kind: 'chip' });
  state = advanceGuide(state, 'setpiece', { ammoId: 'corn' });
  assert.equal(state.mechanism, true);
  assert.equal(state.combined, false);
  assert.equal(state.step, 2);
  state = advanceGuide(state, 'cleared', { ammoId: 'burgerbomb', kind: 'bomb' });
  assert.equal(state.step, 2);
  state = advanceGuide(state, 'damage', { ammoId: 'bun', kind: 'impact' });
  assert.equal(state.step, 2);
  state = advanceGuide(state, 'cleared', { ammoId: 'bun', kind: 'match' });
  assert.equal(state.status, 'completed');
});
