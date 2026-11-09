// Reading pages whose content sits in a frame from another site, as on the 2026-11-09 MyOpenMath
// run: Moodle (gettysburg.mrooms2.net) embeds the homework from www.myopenmath.com, and read_text
// returned "Page text:" with nothing in it. The fixture copies that page's structure from the run.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, makeStore, loadScripts } = H;
const { prep } = require(require('path').join(__dirname, 'engine-test.js'));
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 1200).replace(/\n/g, '\n        ') : ''}`);

const MOODLE = 'https://gettysburg.mrooms2.net/mod/lti/view.php?id=1314971';
const MOM = 'https://www.myopenmath.com/assess2/?cid=342752&aid=23652271#/skip/1';
// Moodle's page: the activity title and the LTI frame; the main region has no text of its own.
const TOP = `<!doctype html><html><head><title>MATH_211_A_Fall_2026: Homework 5.3 Double Integrals in Polar Coordinates | Moodle Home</title></head><body>
  <nav><a href="/">Moodle Home</a></nav>
  <main><h2>Homework 5.3 Double Integrals in Polar Coordinates</h2><iframe id="contentframe" src="${MOM}"></iframe></main>
  <iframe id="tracker" src="https://ads.example.net/px"></iframe>
</body></html>`;
const graph = (k, max) => `<div class="graph"><img src="/graph${k}.png" alt=""><span>(${k})</span><button aria-label="Expand Graph">⌕</button></div>
  <input aria-label="Question 1 Part ${k}a"> ≤ θ ≤ <input aria-label="Question 1 Part ${k}b"><br><input aria-label="Question 1 Part ${k}c"> ≤ r ≤ <input aria-label="Question 1 Part ${k}d">`;
const FRAME = `<!doctype html><html><head><title>Homework 5.3</title></head><body><main>
  <h1>Homework 5.3 Double Integrals in Polar Coordinates</h1>
  <div class="question"><p>Set up limits of integration to integrate over each polar region shown.</p>${['a', 'b', 'c', 'd'].map(k => graph(k)).join('')}</div>
</main></body></html>`;

function windows({ frameReadable = true } = {}) {
  const top = new JSDOM(TOP, { runScripts: 'dangerously', pretendToBeVisual: true, url: MOODLE }).window; prep(top);
  // jsdom has no layout: the homework frame is big, the tracker pixel is 1×1.
  const rect = top.Element.prototype.getBoundingClientRect;
  top.Element.prototype.getBoundingClientRect = function () { return this.id === 'contentframe' ? { left: 70, top: 250, width: 1140, height: 580, right: 1210, bottom: 830 } : this.id === 'tracker' ? { left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 } : rect.call(this); };
  const frame = new JSDOM(FRAME, { runScripts: 'dangerously', pretendToBeVisual: true, url: MOM }).window; prep(frame);
  return { 0: top, ...(frameReadable && { 260: frame }) };
}

function panel(frames) {
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/sidepanel.html' }).window;
  const calls = [];
  w.chrome = {
    storage: { local: makeStore({ anthropicKey: 'k' }), session: makeStore() },
    tabs: { get: async id => ({ id, windowId: 1, active: true, status: 'complete', url: MOODLE, title: frames[0].document.title }) },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        calls.push(target);
        const ids = target.allFrames ? Object.keys(frames).map(Number) : target.frameIds || [0];
        return Promise.all(ids.filter(id => frames[id]).map(async id => ({ frameId: id, result: JSON.parse(JSON.stringify((await frames[id].eval(`(${func.toString()})`)(...(args || [])) ) ?? null)) })));
      }
    },
    runtime: { getURL: p => p }
  };
  loadScripts(w, ['agent.js'], ['readAllText', 'groupRepeats']);
  return { w, calls };
}

(async () => {
  // ---------- 1. the question text inside the frame is read ----------
  {
    const { w, calls } = panel(windows());
    const text = await w.readAllText({ tabId: 5 });
    check('read_text reads every frame (allFrames)', calls[0]?.allFrames === true);
    check('The homework question inside the MyOpenMath frame is read and says where it came from', /Text inside an embedded frame from www\.myopenmath\.com:\nHomework 5\.3[\s\S]*Set up limits of integration to integrate over each polar region shown\./.test(text), text);
    check('Each part is fenced as untrusted with its own source', /<untrusted_content source="https:\/\/www\.myopenmath\.com\/assess2\//.test(text) && /<untrusted_content source="https:\/\/gettysburg\.mrooms2\.net\//.test(text), text.slice(0, 300));
    check('Tiny tracking frames don\'t count as unreadable content', !/Couldn't read/.test(text), text);
  }

  // ---------- 2. a frame Chrome kept Sidekick out of is named, not skipped silently (rule 6) ----------
  {
    const { w } = panel(windows({ frameReadable: false }));
    const text = await w.readAllText({ tabId: 5 });
    check('An unreadable frame is reported with its site and a next step', /Couldn't read 1 embedded frame \(from www\.myopenmath\.com\): Chrome kept Sidekick out, or it's still loading\. Use screenshot to see it\./.test(text), text);
  }

  // ---------- 3. a page with no text at all says so ----------
  {
    const top = new JSDOM('<!doctype html><html><head><title>Graph</title></head><body><main><canvas></canvas></main></body></html>', { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://plot.example.com/' }).window; prep(top);
    const { w } = panel({ 0: top });
    const text = await w.readAllText({ tabId: 5 });
    check('No readable text: says so and points to screenshot and zoom (never an empty "Page text:")', /^The page has no readable text: its content may be pictures, a canvas or a PDF\. Use screenshot to see it \(and zoom to read small print\)\.$/.test(text), text);
  }

  // ---------- 4. identical buttons are grouped but not interchangeable ----------
  {
    const { w } = panel(windows());
    const lines = ['[260:25] clickable "Expand Graph"', '[260:26] textbox:math "Question 1 Part 1 of 16:" empty', '[260:32] clickable "Expand Graph"', '[260:39] clickable "Expand Graph"', '[260:46] clickable "Expand Graph"'];
    const out = w.groupRepeats(lines).join('\n');
    check('Four "Expand Graph" buttons: one line, ids in page order, each its own (no "any of these works")', /^\[260:25,260:32,260:39,260:46\] clickable "Expand Graph" ×4 \(in page order; each belongs to its own item\)$/m.test(out) && !/any of these/.test(out), out);
  }

  console.log(results.join('\n'));
  const passed = results.filter(r => r.startsWith('PASS')).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.log('CRASH', e.stack); process.exit(1); });
