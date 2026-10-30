const { JSDOM } = require('jsdom');
const fs = require('fs'); const dir = require('path').join(__dirname, '..', 'extension') + '/';
const html = fs.readFileSync(dir+'sidepanel.html','utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.chrome = { storage: { local: { get: async d => d }, session: { get: async () => ({}), remove: async () => {} }, onChanged: { addListener() {} } }, tabs: { query: async () => [] }, runtime: {} };
w.ResizeObserver = class { observe() {} };
// Fake layout: viewport 500px, content height we control.
const sc = w.document.getElementById('scroller');
let contentH = 500, top = 0;
Object.defineProperty(sc, 'clientHeight', { get: () => 500 });
Object.defineProperty(sc, 'scrollHeight', { get: () => contentH });
Object.defineProperty(sc, 'scrollTop', { get: () => top, set: v => { const n = Math.max(0, Math.min(v, contentH - 500)); if (n !== top) { top = n; sc.dispatchEvent(new w.Event('scroll')); } } });
sc.scrollTo = ({ top: t }) => { // simulate a smooth scroll in 5 steps
  const start = top; let i = 0;
  const step = () => { i++; sc.scrollTop = start + (t - start) * i / 5; if (i < 5) setTimeout(step, 20); }; step();
};
require(require('path').join(__dirname, 'helpers.js')).loadScripts(w, ['vendor/marked.js','vendor/purify.min.js','vendor/katex.min.js','vendor/highlight.min.js','vendor/math.js','vendor/nerdamer.js','ai.js','guard.js','profile-core.js','memory.js','skills.js','docs.js','web.js','screen.js','calc.js','page-agent.js','cdp.js','adapters.js','agent.js','session.js','brain.js','sidepanel.js'], ['renderMarkdown','autoScroll']);
const check = (name, ...oks) => console.log(`${oks.every(Boolean) ? 'PASS' : 'FAIL'}  ${name}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const grow = n => { contentH += n; w.eval('autoScroll()'); };
const btn = w.document.getElementById('toBottom');
(async () => {
  for (let i = 0; i < 10; i++) grow(40);
  check('Chat scroll: follows while streaming', top === contentH - 500);
  sc.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -30 })); sc.scrollTop = top - 30;
  const held = top;
  for (let i = 0; i < 10; i++) grow(40);
  check('Chat scroll: wheel up stays put while text grows, arrow button shown', top === held, btn.classList.contains('show'));
  sc.scrollTop = top - 200; sc.scrollTop = top + 50; // scrollbar drag up, then a little down (not to bottom)
  grow(40);
  check('Chat scroll: partial scroll down does not re-grab', top !== contentH - 500);
  btn.click();
  for (let i = 0; i < 6; i++) { await sleep(20); grow(40); } // keep streaming during smooth scroll
  await sleep(600); grow(40);
  check('Chat scroll: arrow button reattaches and follows again, arrow hidden', top === contentH - 500, !btn.classList.contains('show'));
  sc.scrollTop = 100; grow(40);
  check('Chat scroll: scrollbar drag up (no wheel) also detaches', top === 100);
  sc.scrollTop = contentH - 500; grow(40);
  check('Chat scroll: scrolling back to the very bottom reattaches', top === contentH - 500);
  process.exit(0);
})();
