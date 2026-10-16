import test from 'node:test';
import assert from 'node:assert/strict';
import { syncRendererResolution, watchDisplayDensity } from '../src/display-resolution.js';

function renderer(initialRatio = 1) {
  let ratio = initialRatio;
  return {
    calls: [],
    getPixelRatio: () => ratio,
    setPixelRatio(value) { ratio = value; this.calls.push(['ratio', value]); },
    setSize(width, height) { this.calls.push(['size', width, height]); },
  };
}

test('a density change updates the drawing buffer at unchanged CSS dimensions', () => {
  const target = renderer();
  const highDensity = syncRendererResolution(target, { width: 1200, height: 800, dpr: 2 });
  assert.deepEqual(target.calls, [['ratio', 2], ['size', 1200, 800]]);
  assert.deepEqual(highDensity, { width: 1200, height: 800, pixelRatio: 2, bufferWidth: 2400, bufferHeight: 1600 });
  const fractional = syncRendererResolution(target, { width: 1200, height: 800, dpr: 1.25 });
  assert.equal(fractional.bufferWidth, 1500);
  assert.equal(fractional.bufferHeight, 1000);
  assert.equal(target.getPixelRatio(), 1.25);
});

test('moving between mobile and desktop preserves their respective density budgets', () => {
  const target = renderer(2);
  assert.equal(syncRendererResolution(target, { width: 699, height: 900, dpr: 3 }).pixelRatio, 1.5);
  assert.equal(syncRendererResolution(target, { width: 700, height: 900, dpr: 3 }).pixelRatio, 2);
  assert.equal(syncRendererResolution(target, { width: 1200, height: 800, dpr: .8 }).pixelRatio, .8);
  assert.equal(syncRendererResolution(target, { width: 1200, height: 800, dpr: undefined }).pixelRatio, 1);
});

test('unchanged display density avoids resetting the renderer pixel ratio', () => {
  const target = renderer(2);
  syncRendererResolution(target, { width: 1440, height: 900, dpr: 2 });
  assert.deepEqual(target.calls, [['size', 1440, 900]]);
});

test('density observation follows silent repeated changes and releases its frame', () => {
  const frames = new Map();
  let nextFrame = 1;
  const display = {
    devicePixelRatio: 1,
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    tick() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
  };
  const observed = [];
  const stop = watchDisplayDensity(() => observed.push(display.devicePixelRatio), display);
  display.tick();
  assert.deepEqual(observed, []);
  display.devicePixelRatio = 2;
  display.tick();
  assert.deepEqual(observed, [2]);
  display.tick();
  assert.deepEqual(observed, [2]);
  display.devicePixelRatio = 1.25;
  display.tick();
  assert.deepEqual(observed, [2, 1.25]);
  assert.equal(frames.size, 1);
  stop();
  stop();
  display.tick();
  assert.equal(frames.size, 0);
  assert.deepEqual(observed, [2, 1.25]);
});
