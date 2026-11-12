'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/gesture-preload'), 'utf8');
function fixture() {
  const listeners = {}, messages = [], limits = [];
  const pending = new Map(), window = { addEventListener: (name, fn) => { listeners[name] = fn; } };
  let nextID = 0;
  const document = { visibilityState: 'visible', addEventListener: (name, fn) => { listeners[name] = fn; } };
  vm.runInNewContext(source, {
    require: () => ({ ipcRenderer: { send: (...args) => messages.push(args), on: (name, fn) => { listeners[name] = fn; } }, webFrame: { setVisualZoomLevelLimits: (...args) => limits.push(args) } }),
    document, window,
    getComputedStyle: node => ({ overflowX: 'visible', overscrollBehaviorX: 'auto', direction: 'ltr', ...node.style }),
    setTimeout: (fn, delay) => { const id = ++nextID; pending.set(id, { fn, delay }); return id; }, clearTimeout: id => { pending.delete(id); }
  });
  listeners.DOMContentLoaded();
  return {
    messages, limits, listeners, document, window,
    wheel: (x, y = 0, extra = {}) => listeners.wheel({ isTrusted: true, deltaX: x, deltaY: y, deltaMode: 0, composedPath: () => [], ...extra }),
    finish: () => { for (const [id, { fn }] of [...pending].sort((a, b) => a[1].delay - b[1].delay)) { pending.delete(id); fn(); } }
  };
}
test('horizontal sequences navigate once, with the macOS natural-scroll direction', () => {
  const f = fixture();
  f.wheel(-65); f.wheel(-70); f.wheel(-15); f.finish(); f.finish();
  assert.deepEqual(f.messages, [['arco:gesture-navigate', 'back']]);
  f.wheel(130); f.finish();
  assert.equal(f.messages[1][1], 'forward');
});
test('small, cancelled, vertical and diagonal gestures do not navigate', () => {
  const f = fixture();
  f.wheel(-80); f.finish();
  f.wheel(-130); f.wheel(120); f.finish();
  f.wheel(-3, 25); f.wheel(-160, 2); f.finish();
  f.wheel(-140, 100); f.finish();
  assert.deepEqual(f.messages, []);
});
test('synthetic events, pinch and modified/discrete wheels cannot navigate', () => {
  const f = fixture();
  for (const extra of [{ isTrusted: false }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { deltaMode: 1 }]) {
    f.wheel(-150, 0, extra); f.finish();
  }
  assert.deepEqual(f.messages, []);
});
test('page handlers, shadow descendants, scrollable content and CSS boundaries take priority', () => {
  const f = fixture();
  f.wheel(-150, 0, { defaultPrevented: true }); f.finish();
  for (const style of [{ overscrollBehaviorX: 'contain' }, { overscrollBehaviorX: 'none' }, { overflowX: 'auto' }, { overflowX: 'scroll', direction: 'rtl' }]) {
    const node = { nodeType: 1, scrollWidth: 500, clientWidth: 100, scrollLeft: style.direction === 'rtl' ? -50 : 50, style };
    f.wheel(-150, 0, { composedPath: () => [{ nodeType: 3 }, node] });
    f.wheel(-150); f.finish();
  }
  assert.deepEqual(f.messages, []);
});
test('a fresh gesture at a scroll boundary may navigate, including RTL', () => {
  const f = fixture();
  const node = { nodeType: 1, scrollWidth: 500, clientWidth: 100, scrollLeft: 0, style: { overflowX: 'auto' } };
  f.wheel(-150, 0, { composedPath: () => [node] }); f.finish();
  node.style.direction = 'rtl'; node.scrollLeft = -400;
  f.wheel(-150, 0, { composedPath: () => [node] }); f.finish();
  assert.equal(f.messages.length, 2);
});
test('late page cancellation and zoomed-page panning cannot navigate', () => {
  const f = fixture();
  // Mutate the actual event after Arco's listener, as a later window listener would.
  const lateEvent = { isTrusted: true, deltaX: -150, deltaY: 0, deltaMode: 0, composedPath: () => [], defaultPrevented: false };
  f.listeners.wheel(lateEvent); lateEvent.defaultPrevented = true; f.finish();
  f.window.visualViewport = { scale: 2 }; f.wheel(-150); f.finish();
  assert.deepEqual(f.messages, []);
});
test('pagehide, blur and visibility changes discard pending navigation', () => {
  const f = fixture();
  for (const name of ['pagehide', 'blur', 'visibilitychange']) {
    f.wheel(-150); f.listeners[name](); f.finish();
  }
  f.document.visibilityState = 'hidden'; f.wheel(-150); f.finish();
  assert.deepEqual(f.messages, []);
});
test('native pinch is enabled and reset clamps visual scale before re-enabling it', () => {
  const f = fixture();
  f.listeners['arco:reset-visual-zoom']();
  assert.deepEqual(f.limits, [[1, 5], [1, 1], [1, 5]]);
});
