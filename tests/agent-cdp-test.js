const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, sleep, makeStore, sseResponse, anthropicEvents, loadScripts, fs, DIR } = H;
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 500).replace(/\n/g, '\n        ') : ''}`);

const PAGE = `<!doctype html><html><head><title>Book seats · Example</title></head><body>
<main><h1>Checkout</h1>
<form id="f">
  <label for="name">Full name</label><input id="name">
  <label for="email">Email</label><input id="email" type="email">
  <label for="notes">Notes</label><textarea id="notes"></textarea>
  <button type="button" id="next">Next</button>
  <button type="submit" id="submit">Place order</button>
</form>
<form id="search"><input id="q" aria-label="Search"></form>
<canvas id="map" aria-label="Seat map" width="300" height="200"></canvas>
<button id="danger">Delete account</button>
</main>
<script>
  window.log = [];
  document.getElementById('next').addEventListener('click', e => log.push('next:' + e.isTrusted));
  document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); log.push('submitted'); });
  document.getElementById('search').addEventListener('submit', e => { e.preventDefault(); log.push('searched:' + q.value); });
  document.getElementById('map').addEventListener('click', e => log.push('map@' + e.clientX + ',' + e.clientY));
  document.getElementById('danger').addEventListener('click', () => log.push('deleted'));
</script></body></html>`;

function makePage(url) {
  const dom = new JSDOM(PAGE, { runScripts: 'dangerously', pretendToBeVisual: true, url });
  const w = dom.window;
  // Give every element a distinct position so coordinates mean something.
  const all = () => [...w.document.querySelectorAll('body *')];
  const rectOf = el => {
    const i = all().indexOf(el);
    if (el.tagName === 'CANVAS') return { left: 10, top: 500, width: 300, height: 200, right: 310, bottom: 700 };
    if (i < 0 || ['MAIN', 'FORM', 'SCRIPT'].includes(el.tagName)) return { left: 0, top: 0, width: 1024, height: 768, right: 1024, bottom: 768 };
    return { left: 20, top: 40 + i * 30, width: 200, height: 24, right: 220, bottom: 64 + i * 30 };
  };
  w.Element.prototype.getBoundingClientRect = function () { return rectOf(this); };
  w.document.elementFromPoint = (x, y) => {
    const hits = all().filter(e => !['MAIN', 'FORM', 'SCRIPT', 'H1'].includes(e.tagName)).filter(e => { const r = rectOf(e); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
    return hits.pop() || w.document.body;
  };
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, configurable: true });
  w.PointerEvent = w.MouseEvent; w.CSS = { escape: s => s };
  w.Element.prototype.scrollIntoView = () => {}; w.scrollBy = w.scrollTo = () => {};
  return w;
}

// Fake Chrome debugger: real-ish clicks by coordinate and typing into the focused field.
function fakeDebugger(page, { failAttach = false } = {}) {
  const cmds = [];
  const listeners = [];
  return {
    cmds,
    api: {
      attach: async () => { if (failAttach) throw new Error('Another debugger is already attached'); cmds.push(['attach']); },
      detach: async () => cmds.push(['detach']),
      onDetach: { addListener: f => listeners.push(f), removeListener: () => {} },
      sendCommand: async (target, method, p) => {
        cmds.push([method, p]);
        const d = page.document;
        if (method === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased') {
          const el = d.elementFromPoint(p.x, p.y);
          el.dispatchEvent(new page.MouseEvent('click', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y }));
        }
        if (method === 'Input.insertText') {
          const el = d.activeElement;
          if (el && 'value' in el) {
            const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
            el.value = el.value.slice(0, s) + p.text + el.value.slice(e);
            el.dispatchEvent(new page.Event('input', { bubbles: true }));
          }
        }
        if (method === 'Input.dispatchKeyEvent' && p.type === 'keyDown' && p.key === 'Enter') {
          const el = d.activeElement;
          if (el?.form) el.form.requestSubmit();
        }
        if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1024, clientHeight: 768 } };
        if (method === 'Page.captureScreenshot') return { data: Buffer.from('jpegbytes').toString('base64') };
        return {};
      }
    }
  };
}

async function runScenario({ url = 'https://tickets.example.com/checkout', settings = {}, plan, failAttach = false, approveAll = true, approvals }) {
  const page = makePage(url);
  const dbg = fakeDebugger(page, { failAttach });
  const local = makeStore({ anthropicKey: 'k', profile: { fullName: 'Ulugbek K' }, ...settings });
  const panel = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/sidepanel.html' });
  const w = panel.window;
  const reqs = [];
  w.chrome = {
    storage: { local, session: makeStore() },
    tabs: {
      query: async () => [{ id: 5, windowId: 1, active: true, url, title: 'Book seats' }],
      get: async id => ({ id, windowId: 1, active: true, status: 'complete', url, title: 'Book seats' }),
      onCreated: { addListener() {}, removeListener() {} },
      captureVisibleTab: async () => 'data:image/jpeg;base64,AAAA', update: async () => ({})
    },
    scripting: { executeScript: async ({ func, args }) => [{ frameId: 0, result: JSON.parse(JSON.stringify(await page.eval(`(${func.toString()})`)(...(args || [])) ?? null)) }] },
    debugger: dbg.api,
    runtime: { getURL: p => p }
  };
  w.createImageBitmap = async () => ({ width: 2048, height: 1536 });
  w.OffscreenCanvas = class { constructor(a, b) { this.w = a; this.h = b; } getContext() { return { drawImage() {} }; } async convertToBlob() { return new w.Blob(['x'], { type: 'image/jpeg' }); } };
  w.fetch = async (u, o) => {
    if (String(u).startsWith('data:')) return { blob: async () => new w.Blob(['img'], { type: 'image/jpeg' }) };
    const body = JSON.parse(o.body); { const __ck = H.checkerReply(body); if (__ck) return __ck; } reqs.push(body);
    const step = body.messages.filter(m => m.role === 'assistant').length;
    const snap = JSON.stringify(body.messages);
    const id = re => { const m = snap.match(new RegExp(String.raw`\[(\d+)\] [a-z:]+ \\"` + re)); return m && m[1]; };
    const [name, input] = plan[step]({ id, snap });
    return sseResponse(anthropicEvents([{ type: 'tool_use', id: 'tu' + step, name, input }], { stop: 'tool_use' }));
  };
  loadScripts(w, ['ai.js', 'guard.js', 'profile-core.js', 'memory.js', 'skills.js', 'docs.js', 'screen.js', 'page-agent.js', 'cdp.js', 'adapters.js', 'agent.js'], ['runAgent']);
  const steps = [], asked = [];
  const ui = {
    signal: new AbortController().signal,
    step: t => { const s = { t }; steps.push(s); return { waiting() {}, done: (ok, d) => { s.ok = ok; s.d = d; } }; },
    note() {},
    approve: async a => { asked.push(a.title); return approvals ? approvals.shift() : approveAll; },
    ask: async () => 'ok'
  };
  const r = await w.runAgent('Book a seat', ui);
  return { r, steps, asked, cmds: dbg.cmds, log: page.log, page, reqs };
}

(async () => {
  // ---------- 1. real input end to end ----------
  {
    const { r, steps, asked, cmds, log, page, reqs } = await runScenario({
      approvals: [false, true],
      plan: [
        ({ id }) => ['type', { id: id('Full name'), text: 'Ulugbek K' }],
        ({ id }) => ['type', { id: id('Email'), text: 'u@example.edu' }],
        ({ id }) => ['click', { id: id('Next'), description: 'Go to the next step', final_action: false }],
        ({ id }) => ['press_key', { id: id('Email'), key: 'Enter' }],
        ({ id }) => ['type', { id: id('Search'), text: 'aisle' }],
        ({ id }) => ['press_key', { id: id('Search'), key: 'Enter' }],
        () => ['screenshot', {}],
        () => ['click_at', { x: 160, y: 600, description: 'Pick seat 12A on the seat map', final_action: false }],
        ({ id }) => ['click', { id: id('Place order'), description: 'Place the order', final_action: true }],
        () => ['done', { summary: 'Booked.' }]
      ]
    });
    const d = page.document;
    const methods = cmds.map(c => c[0]);
    check('Debugger attached once and detached at the end', methods.filter(m => m === 'attach').length === 1 && methods.at(-1) === 'detach');
    check('Typing uses real keyboard input (Input.insertText)', cmds.filter(c => c[0] === 'Input.insertText').map(c => c[1].text).join('|') === 'Ulugbek K|u@example.edu|aisle' && d.getElementById('name').value === 'Ulugbek K' && d.getElementById('email').value === 'u@example.edu');
    const press = cmds.find(c => c[0] === 'Input.dispatchMouseEvent' && c[1].type === 'mousePressed');
    check('Clicks are real mouse events at the element\'s center', press && press[1].x === 120 && log.includes('next:false'), JSON.stringify(press));
    check('Enter in a big form needs approval; declined = not submitted', asked[0] === 'Press Enter, which will submit this form' && log.filter(x => x === 'submitted').length === 1 && steps.find(s => /Press Enter/.test(s.t))?.d === 'You declined');
    check('Enter in a small search box works without asking', log.includes('searched:aisle') && asked.filter(a => /Enter/.test(a)).length === 1);
    const shotResult = JSON.stringify(reqs[7].messages.at(-1));
    check('Screenshot via debugger, sized to CSS pixels for click_at', methods.includes('Page.captureScreenshot') && /1024×768 px; click_at uses these coordinates/.test(shotResult));
    check('click_at lands on the canvas at those coordinates', log.includes('map@160,600') && steps.some(s => s.t === 'Pick seat 12A on the seat map' && s.ok));
    check('Final action asks first, then submits', asked.at(-1)?.startsWith('Click “Place order”') && log.includes('submitted'));
    check('Snapshots are fenced as untrusted content', /<untrusted_content source=\\"https:\/\/tickets\.example\.com\/checkout\\">/.test(JSON.stringify(reqs[0].messages[0])));
    check('Agent finished', r.summary === 'Booked.');
  }

  // ---------- 2. blocked site ----------
  {
    const { steps, cmds, page } = await runScenario({
      url: 'https://www.paypal.com/checkout',
      plan: [({ id }) => ['type', { id: id('Full name'), text: 'x' }], () => ['done', { summary: 'Could not.' }]]
    });
    check('Blocked site: reading OK, acting refused with a clear reason', /paypal\.com is on your "never act on" list/.test(steps[0].d) && !cmds.some(c => c[0] === 'Input.insertText') && page.document.getElementById('name').value === '');
  }

  // ---------- 3. ask before every action ----------
  {
    const { asked, page } = await runScenario({
      settings: { approvalMode: 'every' },
      approvals: [false],
      plan: [({ id }) => ['type', { id: id('Full name'), text: 'x' }], () => ['done', { summary: 'ok' }]]
    });
    check('"Ask before every action" asks before typing', asked.length === 1 && /Type “x”/.test(asked[0]) && page.document.getElementById('name').value === '');
  }

  // ---------- 4. debugger unavailable → simulated input fallback ----------
  {
    const { cmds, log, page } = await runScenario({
      failAttach: true,
      plan: [
        ({ id }) => ['type', { id: id('Full name'), text: 'Fallback' }],
        ({ id }) => ['click', { id: id('Next'), description: 'Next', final_action: false }],
        () => ['done', { summary: 'ok' }]
      ]
    });
    check('If the debugger can\'t attach, simulated input still works', !cmds.some(c => c[0].startsWith('Input.')) && page.document.getElementById('name').value === 'Fallback' && log.includes('next:false'));
  }

  // ---------- 5. trusted input turned off ----------
  {
    const { cmds } = await runScenario({ settings: { trustedInput: false }, plan: [({ id }) => ['type', { id: id('Full name'), text: 'a' }], () => ['done', { summary: 'ok' }]] });
    check('Setting off: debugger never attached', !cmds.length);
  }

  // ---------- 6. secrets still refused with real input ----------
  {
    const { steps, cmds } = await runScenario({ plan: [({ id }) => ['type', { id: id('Notes'), text: 'card 4242 4242 4242 4242' }], () => ['done', { summary: 'ok' }]] });
    check('Card numbers refused before any keystroke', /never types those/.test(steps[0].d) && !cmds.some(c => c[0] === 'Input.insertText'));
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
