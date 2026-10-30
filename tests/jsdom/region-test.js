const { JSDOM } = require('jsdom');
const fs = require('fs');
const H = require(require('path').join(__dirname, 'helpers.js'));
const check = (name, ...oks) => console.log(`${oks.every(Boolean) ? 'PASS' : 'FAIL'}  ${name}`);
const run = async (drive) => {
  const dom = new JSDOM('<!doctype html><body><h1>page</h1></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; w.Element.prototype.setPointerCapture = () => {};
  H.loadScripts(w, ['page/region.js']);
  const p = w.pickRegionInPage();
  const host = w.document.documentElement.lastElementChild;
  const ov = host.shadowRoot; // closed root: grab via internals isn't possible, so reach the overlay by dispatching on host's shadow? use stored reference
  return { w, p };
};
(async () => {
  // closed shadow roots aren't reachable from outside, so patch attachShadow to keep a handle for the test
  const dom = new JSDOM('<!doctype html><body><h1>page</h1></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; w.Element.prototype.setPointerCapture = () => {};
  const orig = w.Element.prototype.attachShadow; let root;
  w.Element.prototype.attachShadow = function (o) { root = orig.call(this, o); return root; };
  H.loadScripts(w, ['page/region.js']);
  let p = w.pickRegionInPage();
  const ov = root.querySelector('.ov');
  const pe = (type, x, y) => { const e = new w.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }); e.pointerId = 1; ov.dispatchEvent(e); };
  pe('pointerdown', 300, 200); pe('pointermove', 120, 90); pe('pointerup', 120, 90);
  const r = await p;
  check('Area capture: drag right-to-left gives a normalized box', r && r.x === 120 && r.y === 90 && r.w === 180 && r.h === 110);
  check('Area capture: overlay removed after pick', !w.document.querySelector('div[style*="2147483647"]'));
  p = w.pickRegionInPage();
  const ov2 = root.querySelector('.ov');
  const e1 = new w.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }); ov2.dispatchEvent(e1);
  const e2 = new w.MouseEvent('pointerup', { clientX: 12, clientY: 11, button: 0 }); ov2.dispatchEvent(e2);
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
  check('Area capture: tiny click ignored, Esc cancels', (await p) === null);
  p = w.pickRegionInPage();
  root.querySelector('button').click();
  check('Area capture: Cancel button cancels, overlay gone', (await p) === null, !w.document.querySelector('div[style*="2147483647"]'));
  process.exit(0);
})();
