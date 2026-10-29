// v0.9.1: regression tests for the bugs Ulugbek reported on 2026-10-28 (see LESSONS.md).
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, sleep, makeStore, sseResponse, anthropicEvents, openaiEvents, loadScripts, fs, DIR, PANEL_SCRIPTS } = H;
const { prep } = require(require('path').join(__dirname, 'engine-test.js'));
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 1200).replace(/\n/g, '\n        ') : ''}`);
const text = t => sseResponse(anthropicEvents([{ type: 'text', text: t }]));
const isChecker = b => /meticulous checker/.test(b.system || b.instructions || '');
const isSolver = b => /independent problem solver/.test(b.system || b.instructions || '');
const BRAIN = ['vendor/math.js', 'vendor/nerdamer.js', 'ai.js', 'guard.js', 'profile-core.js', 'memory.js', 'skills.js', 'docs.js', 'web.js', 'screen.js', 'calc.js', 'session.js', 'adapters.js', 'memory-io.js', 'brain.js'];
const AGENT = ['ai.js', 'guard.js', 'profile-core.js', 'memory.js', 'skills.js', 'docs.js', 'screen.js', 'page-agent.js', 'cdp.js', 'adapters.js', 'agent.js'];

// A Claude stream with summarized thinking, then text, delivered slowly so the UI can be watched.
function thinkingStream(thoughts, answer, delay = 15) {
  const ev = [{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }];
  for (const t of thoughts) ev.push({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } });
  ev.push({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }, { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  for (const p of answer.match(/[\s\S]{1,8}/g)) ev.push({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: p } });
  ev.push({ type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }, { type: 'message_stop' });
  return sseResponse(ev, { delay });
}

async function panel(responder, init = {}) {
  const local = makeStore({ anthropicKey: 'k', ...init });
  const html = fs.readFileSync(DIR + 'sidepanel.html', 'utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
  const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/sidepanel.html' }).window;
  H.basicDom(w);
  w.chrome = { storage: { local, session: makeStore(), onChanged: { addListener() {} } }, tabs: { query: async () => [{ id: 1, url: 'https://example.com', title: 'Example' }], create: async () => {}, captureVisibleTab: async () => 'data:image/jpeg;base64,X' }, scripting: { executeScript: async () => [] }, runtime: { getURL: p => p } };
  w.createImageBitmap = async () => ({ width: 800, height: 600 });
  const reqs = [];
  w.fetch = async (u, o) => { if (String(u).startsWith('data:')) return { blob: async () => new w.Blob(['x'], { type: 'image/jpeg' }) }; const b = JSON.parse(o.body); reqs.push(b); if (/You keep the pinned notes/.test(b.system)) return text('{"notes":[]}'); return responder(b, reqs); };
  loadScripts(w, PANEL_SCRIPTS, ['openChat']);
  await sleep(120);
  return { w, local, reqs, $: s => w.document.querySelector(s), $$: s => [...w.document.querySelectorAll(s)] };
}
async function send(p, prompt, watch) {
  p.$('#input').value = prompt; p.$('#input').dispatchEvent(new p.w.Event('input')); p.$('#send').click();
  const n = p.$$('.msg.ai .actions').length;
  for (let i = 0; i < 600 && p.$$('.msg.ai .actions').length <= n; i++) { await sleep(10); watch?.(); }
  await sleep(30);
}

(async () => {
  // ---------- 1. "Always report what it's doing; show its thinking" ----------
  {
    const seen = { labels: new Set(), previews: new Set(), time: false };
    const p = await panel(b => thinkingStream(['I need to set up the Lagrange system: grad f = λ grad g.\n\n', 'From the two equations, y^3 = x^3, so x = y.\n', 'Then 2x^3 = 54, x = 3.'], 'The maximum is $e^9$.', 25));
    await send(p, 'tell me something', () => {
      const t = p.$('.msg.ai:last-child .thinking');
      if (!t) return;
      seen.labels.add(t.querySelector('.st-label')?.textContent);
      seen.previews.add(t.querySelector('.st-preview')?.textContent);
    });
    const req = p.reqs.find(r => !/You keep the pinned notes/.test(JSON.stringify(r.system)));
    check('Requests summarized thinking from Claude (it is hidden by default on 5.x)', req.thinking?.type === 'adaptive' && req.thinking?.display === 'summarized', JSON.stringify(req.thinking));
    check('While working: a live status with the current stage and the latest thought', seen.labels.has('Thinking') && seen.labels.has('Writing the answer') && [...seen.previews].some(x => /x = y/.test(x || '')), JSON.stringify([...seen.labels, ...seen.previews]));
    const done = p.$('.msg.ai:last-child .thinking');
    check('When done: collapses into "Thought for Ns", full thinking inside', done && !done.classList.contains('live') && /^Thought for \d+s$/.test(done.querySelector('.st-label').textContent) && /Lagrange system/.test(done.querySelector('.thought-text').textContent) && !done.open);
    const saved = Object.entries(p.local.data()).find(([k]) => k.startsWith('chat:'))[1];
    check('Thinking is saved with the chat and comes back when reopened', /x = y/.test(saved.messages[1].thoughts?.text || '') && await (async () => { await p.w.openChat(saved.id); await sleep(30); return /Thought for/.test(p.$('.msg.ai .thinking .st-label')?.textContent || '') && /Lagrange/.test(p.$('.msg.ai .thinking .thought-text')?.textContent || ''); })());
    const quick = await panel(() => text('Hi!'));
    await send(quick, 'hello');
    check('Quick replies without thinking leave no status behind', !quick.$('.msg.ai .thinking'));
  }
  // Double-check stages and thinking show while the answer is held.
  {
    const labels = new Set(), phases = new Set();
    const p = await panel(b => isChecker(b) ? thinkingStream(['Re-solving with the calculator…'], '<verdict>correct</verdict>', 20) : text('x = 4'));
    await send(p, 'solve 2x + 3 = 11, just give me the answer', () => {
      const t = p.$('.msg.ai:last-child .thinking');
      if (t) labels.add(t.querySelector('.st-label').textContent);
      p.$$('.msg.ai:last-child .thought-phase').forEach(x => phases.add(x.textContent));
    });
    check('Held answer: the status says what it is doing (solving, double-checking)', labels.has('Solving and double-checking before showing the answer') || labels.has('Double-checking the answer'), [...labels].join(' | '));
    check('The double-check\'s thinking is shown under its own heading', phases.has('Double-check'), [...phases].join());
  }
  // Fallbacks when a model rejects the thinking/summary setting.
  {
    const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/x.html' }).window;
    w.chrome = { storage: { local: makeStore({ anthropicKey: 'k' }), session: makeStore() }, runtime: { getURL: p => p } };
    const bodies = [];
    w.fetch = async (u, o) => { const b = JSON.parse(o.body); bodies.push(b); if (b.thinking) return new Response(JSON.stringify({ error: { message: 'thinking.display: unsupported for this model' } }), { status: 400 }); return text('ok'); };
    loadScripts(w, ['ai.js', 'guard.js'], ['modelCall']);
    const r = await w.modelCall({ tier: 'smart', model: 'claude-old-1', system: 's', messages: [{ role: 'user', text: 'hi' }] });
    await w.modelCall({ tier: 'smart', model: 'claude-old-1', system: 's', messages: [{ role: 'user', text: 'hi' }] });
    check('Claude: a model that rejects thinking is retried without it (and remembered)', r.text === 'ok' && bodies.length === 3 && !bodies[1].thinking && !bodies[2].thinking);
    const w2 = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/x.html' }).window;
    w2.chrome = { storage: { local: makeStore({ openaiKey: 'k', provider: 'openai' }), session: makeStore() }, runtime: { getURL: p => p } };
    const ob = []; const thoughts = [];
    w2.fetch = async (u, o) => {
      const b = JSON.parse(o.body); ob.push(b);
      if (b.reasoning?.summary) return new Response(JSON.stringify({ error: { message: 'Your organization must be verified to generate reasoning summaries.' } }), { status: 400 });
      const ev = openaiEvents({ text: 'ok' }); ev.splice(1, 0, { type: 'response.reasoning_summary_text.delta', delta: 'thinking…' });
      return sseResponse(ev);
    };
    loadScripts(w2, ['ai.js', 'guard.js'], ['modelCall']);
    const r2 = await w2.modelCall({ tier: 'smart', system: 's', messages: [{ role: 'user', text: 'hi' }], onThinking: t => thoughts.push(t) });
    check('OpenAI: asks for a reasoning summary; if the account can\'t, keeps reasoning without it', ob[0].reasoning?.summary === 'auto' && ob[1].reasoning?.effort && !ob[1].reasoning.summary && r2.text === 'ok' && thoughts.includes('thinking…'));
  }

  // ---------- 2. "It only solved one part" (Lagrange max/min with DNE) ----------
  {
    const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' }).window;
    loadScripts(w, ['vendor/math.js', 'vendor/nerdamer.js', 'calc.js'], ['calcEngine']);
    const out = await w.calcEngine.run(['scanCurve(exp(x*y), x^3 + y^3 = 54, x, y)']);
    check('scanCurve: e^(xy) on x³+y³=54 → max 8103.0839 at (3,3) reached; min NOT attained → DNE', /largest f = 8103\.0839\d* at x = 3, y = 3 \(reached/.test(out) && /minimum is NOT attained: answer DNE/.test(out), out);
    const circle = await w.calcEngine.run(['scanCurve(x*y, x^2 + y^2 = 8, x, y)']);
    check('scanCurve: on a closed curve both extremes are reached (max 4, min -4)', /largest f = 4 at/.test(circle) && /smallest f = -4 at/.test(circle) && !/DNE/.test(circle), circle);

    const Q = 'Find the maximum and minimum values of the function f(x,y)=e^{xy} subject to x^3+y^3=54. Please show your answers to at least 4 decimal places. Enter DNE if the value does not exist.';
    const BOTH = 'The maximum and minimum values of $f(x, y) = e^{xy}$ subject to $x^3 + y^3 = 54$ are both **8103.0839**.';
    const RIGHT = '<final_answer>**Maximum value: 8103.0839**\n**Minimum value: DNE** (f → 0 along the curve but never reaches it)</final_answer>';
    const reqs = [];
    const w2 = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/x.html' }).window;
    w2.chrome = { storage: { local: makeStore({ anthropicKey: 'k' }), session: makeStore() }, runtime: { getURL: p => p } };
    w2.fetch = async (u, o) => { const b = JSON.parse(o.body); reqs.push(b); return isChecker(b) ? text('<verdict>correct</verdict>') : isSolver(b) ? text(RIGHT) : text(BOTH); };
    loadScripts(w2, BRAIN, ['runTurn']);
    const chips = [];
    const r = await w2.runTurn([], { text: Q }, { hasTab: false, onToolStart: n => { const c = { n }; chips.push(c); return { done: s => (c.done = s), fail() {} }; } });
    check('Same value for max and min is caught even when the double-check agrees → third solve → max 8103.0839, min DNE', r.corrected && /Minimum value: DNE/.test(r.text) && r.review?.by === 'completeness' && /^Fixed: the answer says the maximum and minimum are both/.test(chips.find(c => c.n === 'verify')?.done || ''), JSON.stringify([r.text, chips]));
    const sys = reqs[0].system;
    check('Prompt: Lagrange gives candidates only; decide existence; scanCurve for unbounded constraints; answer every part', /Lagrange only finds candidates/.test(sys) && /scanCurve\(f, constraint, x, y\)/.test(sys) && /answer DNE for it/.test(sys) && /Answer every part the question asks/.test(sys));
    check('Checker prompt: must check every part and whether each extreme exists', /covers EVERY part asked/.test(JSON.stringify(reqs.find(isChecker).messages)));
  }

  // ---------- 4. "Every time I open Sidekick it should start a new chat" ----------
  {
    const local = makeStore({ anthropicKey: 'k' });
    const html = fs.readFileSync(DIR + 'sidepanel.html', 'utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
    const boot = async () => {
      const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/sidepanel.html' }).window;
      H.basicDom(w);
      w.chrome = { storage: { local, session: makeStore(), onChanged: { addListener() {} } }, tabs: { query: async () => [] }, runtime: { getURL: p => p } };
      w.fetch = async (u, o) => { const b = JSON.parse(o.body); if (/You keep the pinned notes/.test(b.system)) return text('{"notes":[]}'); return new Promise(() => {}); }; // reply never comes
      loadScripts(w, PANEL_SCRIPTS);
      await sleep(100);
      return w;
    };
    const w1 = await boot();
    w1.document.querySelector('#input').value = 'question sent right before closing'; w1.document.querySelector('#input').dispatchEvent(new w1.Event('input')); w1.document.querySelector('#send').click();
    await sleep(80);
    w1.dispatchEvent(new w1.Event('pagehide'));
    await sleep(50);
    const idx = local.data().chatIndex || [];
    check('Closing mid-reply still saves the chat (your question isn\'t lost)', idx.length === 1 && local.data()['chat:' + idx[0].id].messages[0].display.prompt === 'question sent right before closing');
    const w2 = await boot();
    check('Reopening starts a brand-new chat', !w2.document.querySelector('.msg') && !!w2.document.querySelector('.empty'));
  }

  // ---------- 5 & 6. agent: switching tabs, blocked frames, MyOpenMath math boxes ----------
  async function agentRun({ html, url = 'https://class.example.edu/hw', plan, tab = {}, frames, debuggerMode = 'ok', extraTabEvents, onClick }) {
    const page = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url }).window;
    prep(page);
    page.CSS = { escape: s => s };
    // jsdom has no layout: give iframes a real size and route clicks at a point to the page's button.
    const rect = page.Element.prototype.getBoundingClientRect;
    page.Element.prototype.getBoundingClientRect = function () { return this.tagName === 'IFRAME' ? { left: 0, top: 150, width: 800, height: 600, right: 800, bottom: 750 } : rect.call(this); };
    page.document.elementFromPoint = () => page.document.querySelector('button');
    const cmds = [];
    const created = [], activated = [];
    let active = tab.active !== false;
    const local = makeStore({ anthropicKey: 'k', profile: { fullName: 'Ulugbek K' } });
    const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/sidepanel.html' }).window;
    let updated = [];
    w.chrome = {
      storage: { local, session: makeStore() },
      tabs: {
        query: async () => [{ id: 5, windowId: 1, active: true, url, title: 'HW' }],
        get: async id => ({ id, windowId: 1, active: id === 5 ? active : true, status: 'complete', url: id === 5 ? url : 'chrome://newtab/', title: 'HW' }),
        update: async (id, o) => { updated.push([id, o]); return {}; },
        onCreated: { addListener: f => created.push(f), removeListener() {} },
        onActivated: { addListener: f => activated.push(f), removeListener() {} },
        captureVisibleTab: async () => { cmds.push(['captureVisibleTab']); return 'data:image/jpeg;base64,AAAA'; }
      },
      scripting: { executeScript: async ({ func, args, target }) => {
        const res = JSON.parse(JSON.stringify((await page.eval(`(${func.toString()})`)(...(args || []))) ?? null));
        return frames ? frames(res, target) : [{ frameId: 0, result: res }];
      } },
      debugger: {
        attach: async () => cmds.push(['attach']), detach: async () => cmds.push(['detach']),
        onDetach: { addListener() {}, removeListener() {} },
        sendCommand: async (t, method, p) => {
          cmds.push([method, p]);
          if (debuggerMode === 'stall' && method.startsWith('Input.')) return new Promise(() => {});
          const d = page.document;
          if (method === 'Input.insertText') { const el = d.activeElement; if (el && 'value' in el) { el.value += p.text; el.dispatchEvent(new page.Event('input', { bubbles: true })); } }
          if (method === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased') { d.elementFromPoint(p.x, p.y)?.click(); onClick?.(created); }
          if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1024, clientHeight: 768 } };
          return {};
        }
      },
      runtime: { getURL: p => p }
    };
    w.createImageBitmap = async () => ({ width: 1024, height: 768 });
    const reqs = [];
    w.fetch = async (u, o) => {
      const body = JSON.parse(o.body); reqs.push(body);
      if (/reusable operating notes/.test(body.system || '')) return text('{"notes":[]}');
      const step = body.messages.filter(m => m.role === 'assistant').length;
      const all = JSON.stringify(body.messages);
      if (extraTabEvents?.[step]) await extraTabEvents[step]({ created, activated, setActive: v => (active = v) });
      const [name, input] = plan[step]({ all, id: re => { const m = all.match(new RegExp(String.raw`\[(\d+)\] [a-z:]+ \\"` + re)); return m && m[1]; } });
      return sseResponse(anthropicEvents([{ type: 'tool_use', id: 't' + step, name, input }], { stop: 'tool_use' }));
    };
    loadScripts(w, AGENT, ['runAgent']);
    const steps = [], notes = [];
    const ui = { signal: new AbortController().signal, step: t => { const s = { t }; steps.push(s); return { waiting() {}, done: (ok, d) => { s.ok = ok; s.d = d; } }; }, note: t => notes.push(t), approve: async () => true, ask: async () => 'ok', thinking() {} };
    const r = await w.runAgent('Do my homework entry', ui);
    return { r, steps, notes, cmds, page, reqs, updated };
  }

  const FORM = '<!doctype html><html><head><title>HW</title></head><body><main><h1>HW</h1><label for="a">Answer</label><input id="a"><button id="b" onclick="window.clicked=(window.clicked||0)+1">Check</button></main></body></html>';
  {
    // You press Ctrl+T while looking at the agent's tab: Chrome reports the new tab as "opened by" it.
    const r = await agentRun({
      html: FORM,
      plan: [({ id }) => ['type', { id: id('Answer'), text: '42' }], ({ id }) => ['click', { id: id('Check'), description: 'Check', final_action: false }], () => ['done', { summary: 'ok' }]],
      extraTabEvents: { 1: ({ created, activated, setActive }) => { setActive(false); created.forEach(f => f({ id: 9, openerTabId: 5, pendingUrl: 'chrome://newtab/' })); activated.forEach(f => f({ tabId: 9 })); } }
    });
    check('A tab you open yourself is never taken over: the agent keeps working in its own tab', r.page.document.getElementById('a').value === '42' && r.page.clicked === 1 && r.r.summary === 'ok', JSON.stringify(r.steps));
    check('…it tells you it keeps working in the background', r.notes.some(n => /keep working on the page in the background/.test(n)));
    check('…and in a background tab it uses page events, not the debugger (which can stall there)', !r.cmds.some(c => c[0] === 'Input.dispatchMouseEvent'));
  }
  {
    // The page itself opens a tab right after the agent clicks "Apply": that one IS followed.
    const html = '<!doctype html><html><head><title>Job</title></head><body><main><button id="ap">Apply</button></main></body></html>';
    let followed = null;
    const r = await agentRun({
      html, plan: [({ id }) => ['click', { id: id('Apply'), description: 'Apply', final_action: false }], ({ all }) => { followed = /opened a new tab/.test(all); return ['done', { summary: 'ok' }]; }],
      // Like Chrome: the page opens the tab as the click lands.
      onClick: created => created.forEach(f => f({ id: 7, openerTabId: 5, pendingUrl: 'https://boards.greenhouse.io/x' }))
    });
    check('A tab the page opens right after the agent\'s click is followed', followed === true);
  }
  {
    const t0 = Date.now();
    const r = await agentRun({ html: FORM, debuggerMode: 'stall', plan: [({ id }) => ['click', { id: id('Check'), description: 'Check', final_action: false }], ({ id }) => ['type', { id: id('Answer'), text: '7' }], () => ['done', { summary: 'ok' }]] });
    check(`If real input stalls, the agent falls back to page events and finishes (${Math.round((Date.now() - t0) / 1000)}s)`, r.page.clicked === 1 && r.page.document.getElementById('a').value === '7' && r.r.summary === 'ok', JSON.stringify(r.steps));
  }
  {
    const r = await agentRun({ html: FORM, tab: { active: false }, plan: [() => ['screenshot', {}], () => ['done', { summary: 'ok' }]] });
    check('Screenshot of a background tab: doesn\'t pull you back or photograph your tab; explains instead', !r.updated.length && !r.cmds.some(c => c[0] === 'captureVisibleTab' || c[0] === 'Page.captureScreenshot') && /background tab/.test(r.steps[0].d || ''));
  }
  {
    // Moodle page with the MyOpenMath frame Chrome didn't let Sidekick into.
    const html = '<!doctype html><html><head><title>Homework 4.8</title></head><body><main><h1>Homework 4.8</h1><iframe src="https://www.myopenmath.com/assess2/?cid=1" style="width:800px;height:600px"></iframe></main></body></html>';
    let first = '';
    await agentRun({ html, url: 'https://gettysburg.mrooms2.net/mod/lti/view.php?id=1', plan: [({ all }) => { first = all; return ['done', { summary: 'blocked' }]; }] });
    check('A frame Sidekick can\'t get into is reported, by site, with what to tell you', /Can't see inside an embedded frame on this page \(from www\.myopenmath\.com\)/.test(first) && /tell the user exactly that/.test(first), first.slice(0, 600));
    // Chat: reading the problem from the page reports it too.
    const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/x.html' }).window;
    w.chrome = { tabs: { query: async () => [{ id: 1, url: 'https://gettysburg.mrooms2.net/mod/lti/view.php' }] }, scripting: { executeScript: async () => [{ frameId: 0, result: { url: 'https://gettysburg.mrooms2.net/mod/lti/view.php', text: 'Moodle page text that is long enough to keep. '.repeat(3), frames: ['www.myopenmath.com'] } }] }, runtime: { getURL: p => p } };
    loadScripts(w, ['guard.js', 'screen.js'], ['readProblemText']);
    const pg = await w.readProblemText();
    check('Chat: reading the page says when the problem\'s frame couldn\'t be read', /couldn't read an embedded frame on this page \(from www\.myopenmath\.com\)/.test(pg.text), pg.text);
    w.chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.'); };
    const pg2 = await w.readProblemText();
    check('Chat: a page Chrome won\'t let Sidekick read is reported, with how to fix it', /Sidekick can't read this page: Chrome blocked Sidekick from this page.*Site access/.test(pg2.text), pg2.text);
  }
  {
    // MyOpenMath's MathQuill answer boxes.
    const html = `<!doctype html><html><head><title>Q2</title></head><body><main><h1>Question 2</h1>
      <span id="lbl0">Maximum value:</span><input type="text" id="qn0" style="display:none" value="">
      <span class="mq-editable-field mq-math-mode" id="mqinput-qn0" style="display:inline-block;width:200px;height:30px"><span class="mq-textarea"><textarea aria-label="Maximum value" style="width:1px;height:1px"></textarea></span><span class="mq-root-block">8103.0839</span></span>
      <span id="lbl1">Minimum value:</span><input type="text" id="qn1" style="display:none" value="">
      <span class="mq-editable-field mq-math-mode" id="mqinput-qn1" style="display:inline-block;width:200px;height:30px"><span class="mq-textarea"><textarea aria-label="Minimum value" style="width:1px;height:1px"></textarea></span><span class="mq-root-block">−8103.0839</span></span>
      <button>Submit Question</button></main></body></html>`;
    let snap = '';
    const r = await agentRun({ html, plan: [({ all }) => { snap = all; return ['type', { id: all.match(/\[(\d+)\] textbox:math \\"Minimum value\\"/)[1], text: 'DNE' }]; }, () => ['done', { summary: 'ok' }]] });
    check('MyOpenMath math boxes are listed as fields with their label and current value', /textbox:math \\"Maximum value\\" value: \\"8103\.0839\\"/.test(snap) && /textbox:math \\"Minimum value\\" value: \\"−8103\.0839\\", math box/.test(snap) && !/\] textarea \\"Minimum value/.test(snap), snap.slice(0, 900));
    const keys = r.cmds.filter(c => c[0] === 'Input.dispatchKeyEvent' && c[1].type !== 'keyUp').map(c => c[1].key);
    check('Typing into a math box: clears it like a person (End, Backspace ×n), then types', keys[0] === 'End' && keys.filter(k => k === 'Backspace').length >= 10 && r.cmds.some(c => c[0] === 'Input.insertText' && c[1].text === 'DNE'), keys.join(','));
    const r2 = await agentRun({ html, tab: { active: false }, plan: [({ all }) => ['type', { id: all.match(/\[(\d+)\] textbox:math \\"Minimum value\\"/)[1], text: 'DNE' }], () => ['done', { summary: 'ok' }]] });
    check('Without real typing (background tab), the math box\'s hidden answer field is filled instead', r2.page.document.getElementById('qn1').value === 'DNE' && r2.page.document.getElementById('qn0').value === '');
  }

  // ---------- 7. "<untrusted_content> showed up in the answer" ----------
  {
    const reply = '<untrusted_content source="text the user selected on the page">\nHere is the clearer version of your paragraph.\n</untrusted_content>';
    const p = await panel(() => text(reply));
    p.w.document.querySelector('#input').value = 'make this clearer';
    await send(p, 'make this clearer');
    const md = p.$('.msg.ai:last-child > .md').textContent;
    const saved = Object.entries(p.local.data()).find(([k]) => k.startsWith('chat:'))[1].messages.at(-1).text;
    check('Wrapper tags never show in a reply', !/untrusted_content/.test(md) && /clearer version/.test(md), md);
    check('…nor in the saved/copied text', !/untrusted_content/.test(saved) && saved === 'Here is the clearer version of your paragraph.', saved);
    check('Prompt tells the model never to copy the wrapper', /Never copy the <untrusted_content> tags/.test(p.reqs.find(r => !/You keep the pinned notes/.test(JSON.stringify(r.system))).system));
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
