'use strict';
const { ipcRenderer, webFrame } = require('electron');

// Session preload: also runs in reader views and website popups, without exposing IPC to the page.
// Apply after document initialization; data: reader documents otherwise reset the limits.
document.addEventListener('DOMContentLoaded', () => webFrame.setVisualZoomLevelLimits(1, 5), { once: true });
ipcRenderer.on('arco:reset-visual-zoom', () => {
  webFrame.setVisualZoomLevelLimits(1, 1);
  webFrame.setVisualZoomLevelLimits(1, 5);
});

let gesture = null, timer;
const reset = () => { clearTimeout(timer); gesture = null; };
function pageConsumes(event) {
  for (const node of event.composedPath()) {
    if (node.nodeType !== 1) continue;
    const style = getComputedStyle(node);
    if (style.overscrollBehaviorX === 'contain' || style.overscrollBehaviorX === 'none') return true;
    if (!['auto', 'scroll'].includes(style.overflowX) && node !== document.scrollingElement) continue;
    const maximum = node.scrollWidth - node.clientWidth;
    if (maximum <= 1) continue;
    const position = style.direction === 'rtl' ? -node.scrollLeft : node.scrollLeft;
    const delta = style.direction === 'rtl' ? -event.deltaX : event.deltaX;
    if (delta < 0 ? position > 1 : position < maximum - 1) return true;
  }
  return false;
}
window.addEventListener('wheel', event => {
  if (!event.isTrusted) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.deltaMode !== 0 || document.visibilityState !== 'visible') { reset(); return; }
  gesture ||= { x: 0, y: 0, axis: '', blocked: false };
  gesture.x += event.deltaX; gesture.y += event.deltaY;
  gesture.blocked ||= event.defaultPrevented || window.visualViewport?.scale > 1.01 || pageConsumes(event);
  // Page listeners on window may run after this preload listener.
  const current = gesture;
  setTimeout(() => { current.blocked ||= event.defaultPrevented; }, 0);
  if (!gesture.axis && Math.max(Math.abs(gesture.x), Math.abs(gesture.y)) >= 12) {
    gesture.axis = Math.abs(gesture.x) > Math.abs(gesture.y) * 2 ? 'x' : 'y';
  }
  clearTimeout(timer);
  // ponytail: DOM wheel has no macOS gesture phases; a 180ms idle gap ends the sequence.
  // Use a native phase bridge if real trackpad testing shows separate gestures being merged.
  timer = setTimeout(() => {
    const finished = gesture; gesture = null;
    if (finished && !finished.blocked && finished.axis === 'x' && Math.abs(finished.x) >= 120) {
      ipcRenderer.send('arco:gesture-navigate', finished.x < 0 ? 'back' : 'forward');
    }
  }, 180);
}, { passive: true });
window.addEventListener('pagehide', reset);
window.addEventListener('blur', reset);
document.addEventListener('visibilitychange', reset);
