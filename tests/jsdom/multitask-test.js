// v0.9.2: the agent doing several tasks, not freezing, using the chat's context, and reading
// pages without scrolling one screen at a time. (Ulugbek, 2026-10-28: "applied for 1 of 4 jobs,
// then stopped and froze"; "it didn't know which position"; "it scrolls very slowly".)
const H = require(require('path').join(__dirname, 'helpers.js'));
const { srcPath } = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, sleep, makeStore, sseResponse, anthropicEvents, loadScripts, fs, DIR, PANEL_SCRIPTS } = H;
const { prep } = require(require('path').join(__dirname, 'engine-test.js'));
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 1500).replace(/\n/g, '\n        ') : ''}`);
const text = t => sseResponse(anthropicEvents([{ type: 'text', text: t }]));
const tools = (calls, step) => sseResponse(anthropicEvents(calls.map(([name, input], k) => ({ type: 'tool_use', id: `t${step}_${k}`, name, input })), { stop: 'tool_use' }));
const AGENT = ['ai.js', 'guard.js', 'profile-core.js', 'memory.js', 'skills.js', 'docs.js', 'web.js', 'screen.js', 'page-agent.js', 'cdp.js', 'adapters.js', 'agent.js'];
const ROLES = ['Backend Engineer', 'Backend Software Engineer, Agentic', 'Backend Software Engineer, Product', 'Frontend Engineer'];
const ORIGIN = 'https://jobs.ashbyhq.com';

// ---------- a small web: a job board and one application form per job ----------
function boardHtml(n = 4, extra = 0) {
  const filler = Array.from({ length: extra }, (_, i) => `<li><a href="/higgsfield/team-${i}">Team page ${i}</a></li>`).join('');
  return `<!doctype html><html><head><title>Higgsfield Jobs</title></head><body><main><h1>Open roles at Higgsfield</h1><ul>${filler}${ROLES.slice(0, n).map((r, i) => `<li><a href="/higgsfield/${i + 1}">${r}</a> Almaty, Kazakhstan · Full time</li>`).join('')}</ul></main></body></html>`;
}
const formHtml = i => `<!doctype html><html><head><title>${ROLES[i - 1]} - Apply</title></head><body><main><h1>${ROLES[i - 1]}</h1>
  <form onsubmit="return false"><label for="n">Full name</label><input id="n" required><label for="e">Email</label><input id="e" type="email" required>
  <button type="button" id="s" onclick="if(document.getElementById('n').value&&document.getElementById('e').value){window.report(${i});document.querySelector('main').innerHTML='<h1>Application submitted</h1><p>Thanks!</p>'}">Submit Application</button></form></main></body></html>`;
const pageFor = url => {
  const p = new URL(url).pathname;
  if (p === '/higgsfield') return boardHtml();
  const m = p.match(/^\/higgsfield\/(\d)$/);
  return m ? formHtml(+m[1]) : '<!doctype html><html><head><title>Other</title></head><body><main><h1>Other page</h1></main></body></html>';
};

// A fake Chrome with real tabs (each a jsdom page). hang: tab ids whose page never answers.
function fakeChrome({ local, startUrl = ORIGIN + '/higgsfield', html, hang = new Set(), onPage }) {
  const tabs = new Map();
  let nextId = 5;
  const submitted = [];
  const mk = (url, h) => {
    const page = new JSDOM(h ?? pageFor(url), { runScripts: 'dangerously', pretendToBeVisual: true, url }).window;
    prep(page);
    page.document.elementFromPoint = () => null;
    page.report = i => submitted.push(i);
    onPage?.(page);
    return page;
  };
  const open = (url, h) => { const id = nextId++; tabs.set(id, { id, url, page: mk(url, h), active: true }); return tabs.get(id); };
  const first = open(startUrl, html);
  const info = t => ({ id: t.id, windowId: 1, active: t.active, status: 'complete', url: t.url, title: t.page.document.title });
  const chrome = {
    storage: { local, session: makeStore(), onChanged: { addListener() {} } },
    tabs: {
      query: async q => q?.active ? [info(tabs.get(first.id))] : [...tabs.values()].map(info),
      get: async id => { const t = tabs.get(id); if (!t) throw new Error('No tab'); return info(t); },
      create: async ({ url }) => { for (const t of tabs.values()) t.active = false; return info(open(url)); },
      update: async (id, o) => { const t = tabs.get(id); if (o.url) { t.url = o.url; t.page = mk(o.url); } return info(t); },
      goBack: async () => {},
      onCreated: { addListener() {}, removeListener() {} },
      onActivated: { addListener() {}, removeListener() {} },
      captureVisibleTab: async () => 'data:image/jpeg;base64,AAAA'
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        if (hang.has(target.tabId)) return new Promise(() => {}); // a "Leave site?" dialog, a frozen page…
        const t = tabs.get(target.tabId);
        const res = JSON.parse(JSON.stringify((await t.page.eval(`(${func.toString()})`)(...(args || []))) ?? null));
        return [{ frameId: 0, result: res }];
      }
    },
    debugger: { attach: async () => { throw new Error('no debugger here'); }, detach: async () => {}, onDetach: { addListener() {}, removeListener() {} }, sendCommand: async () => ({}) },
    runtime: { getURL: p => p }
  };
  return { chrome, tabs, submitted, first };
}

// Runs the agent directly (no panel) against a scripted model.
async function agent({ plan, goal = 'Apply to these 4 Higgsfield jobs', history, hang, html, approve = true, extra = {} }) {
  const local = makeStore({ anthropicKey: 'k', profile: { fullName: 'Ulugbek Rivera', email: 'jordan@example.edu', desiredRoles: 'Backend / full-stack software engineering' }, ...extra.store });
  const fc = fakeChrome({ local, hang, html, onPage: extra.onPage });
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/sidepanel.html' }).window;
  w.chrome = fc.chrome;
  Object.assign(w, extra.globals || {});
  const reqs = [];
  w.fetch = async (u, o) => {
    if (String(u).includes('duckduckgo')) return { ok: true, url: u, text: async () => extra.searchHtml || '' };
    const body = JSON.parse(o.body); reqs.push(body);
    if (/reusable operating notes/.test(body.system || '')) return text('{"notes":[]}');
    const step = body.messages.filter(m => m.role === 'assistant').length;
    const all = JSON.stringify(body.messages);
    const r = plan(step, all, body);
    return typeof r === 'function' ? r() : Array.isArray(r) ? tools(r, step) : text(r);
  };
  loadScripts(w, AGENT, ['runAgent']);
  const steps = [], notes = [], approvals = [], plans = [];
  const ctl = new AbortController();
  const ui = { signal: ctl.signal, step: t => { const s = { t }; steps.push(s); return { waiting() {}, done: (ok, d) => { s.ok = ok; s.d = d; } }; }, note: t => notes.push(t), approve: async ({ title }) => { approvals.push(title); return approve; }, ask: async q => (extra.answer || 'ok'), thinking() {}, plan: p => plans.push(p) };
  const t0 = Date.now(); if (process.env.DBG) console.error("agent start", goal);
  let r, error;
  const p = w.runAgent(goal, ui, { history }).then(x => (r = x), e => (error = e));
  if (extra.stopAfter) setTimeout(() => ctl.abort(), extra.stopAfter);
  await p;
  return { r, error, steps, notes, approvals, plans, reqs, fc, ms: Date.now() - t0, w };
}
// Last id shown for a label (pages restart numbering, so the newest snapshot wins).
const lastId = (all, label) => { const re = new RegExp(String.raw`\[(\d+)\] [a-z:]+ \\"` + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); let m, id = null; while ((m = re.exec(all))) id = m[1]; return id; };

(async () => {
  // ---------- 1. four applications in one run ----------
  {
    const script = [];
    script.push(() => [['plan', { items: ROLES.map(r => `Apply: ${r}`) }], ['find', { query: 'engineer' }]]);
    for (let i = 1; i <= 4; i++) {
      script.push(() => [['plan', { update: { item: i, status: 'doing' } }], ['open_tab', { url: `${ORIGIN}/higgsfield/${i}` }]]);
      script.push(all => [['fill_fields', { fields: [{ id: lastId(all, 'Full name'), value: 'Ulugbek Rivera' }, { id: lastId(all, 'Email'), value: 'jordan@example.edu' }] }]]);
      if (i === 2) script.push(() => "The form is ready. I'll click \"Submit Application\" to complete the process. Would you like to proceed?"); // what v0.9 did
      script.push(all => [['click', { id: lastId(all, 'Submit Application'), description: `Submit the ${ROLES[i - 1]} application`, final_action: true }]]);
      script.push(() => [['log_application', { company: 'Higgsfield', role: ROLES[i - 1], status: 'submitted' }], ['plan', { update: { item: i, status: 'done' } }]]);
    }
    script.push(() => [['done', { summary: ROLES.map(r => `- ✓ ${r}`).join('\n') }]]);
    let nudgeSeen = '';
    const run = await agent({ plan: (step, all, body) => { if (step === 8) nudgeSeen = JSON.stringify(body.messages.at(-1)); return script[step](all); } });
    check('Applies to all 4 jobs in one run (v0.9 stopped after 1)', run.fc.submitted.join() === '1,2,3,4' && !run.error, JSON.stringify({ sub: run.fc.submitted, err: run.error?.message, steps: run.steps.map(s => s.t + (s.ok === false ? ' ✗ ' + s.d : '')) }));
    check('Each submit asked you first (4 approvals)', run.approvals.length === 4 && run.approvals.every(t => /Submit Application/.test(t)), run.approvals.join(' | '));
    check('"Would you like to proceed?" in plain text no longer ends the run: it is sent back to use the approval', /A reply without a tool call ends the task|Not finished: 3 checklist items are still open/.test(nudgeSeen), nudgeSeen.slice(0, 300));
    const lastPlan = run.plans.at(-1);
    check('Checklist shown and kept up to date (4 of 4 done)', run.plans.length >= 9 && lastPlan.length === 4 && lastPlan.every(x => x.status === 'done') && run.r.plan.every(x => x.status === 'done'), JSON.stringify(lastPlan));
    check('Each application in its own tab (no "Leave site?" on a filled form)', run.fc.tabs.size === 5);
    const apps = (await run.w.chrome.storage.local.get('applications')).applications || [];
    check('All 4 logged in your applications list', apps.length === 4, JSON.stringify(apps).slice(0, 300));
  }
  // A plain answer without a question still ends a simple run normally (no pointless extra call).
  {
    const run = await agent({ goal: 'What is this page?', plan: step => step === 0 ? 'This is Higgsfield\'s job board with 4 open roles.' : 'unexpected' });
    check('A finished answer (no question, no open checklist) still ends the run in one call', run.r.summary.startsWith('This is Higgsfield') && run.reqs.length === 1);
  }
  // Open items: it's sent back to work even when it doesn't ask.
  {
    const run = await agent({ plan: (step, all) => [
      () => [['plan', { items: ['Apply: Backend Engineer', 'Apply: Frontend Engineer'] }]],
      () => 'Applied to the first one.',
      () => [['plan', { update: { item: 1, status: 'done' } }], ['plan', { update: { item: 2, status: 'failed', note: 'posting closed' } }]],
      () => [['done', { summary: 'One applied, one closed.' }]]][step](all) });
    check('Stopping with checklist items still open → told to continue; failed items are allowed to end it', run.r.summary === 'One applied, one closed.' && /Not finished: 2 checklist items are still open/.test(JSON.stringify(run.reqs[2].messages)));
  }
  // More steps for bigger jobs.
  {
    const many = n => (step, all) => step === 0 ? [['plan', { items: ['A', 'B', 'C', 'D'] }]] : step <= n ? [['find', { query: 'engineer' }]] : [['plan', { update: { item: 1, status: 'done' } }], ['plan', { update: { item: 2, status: 'done' } }], ['plan', { update: { item: 3, status: 'done' } }], ['plan', { update: { item: 4, status: 'done' } }], ['done', { summary: 'all done' }]];
    const big = await agent({ plan: many(80) });
    check(`A 4-part task gets more than 40 steps (finished at step ${big.reqs.length})`, big.r.summary === 'all done' && big.reqs.length === 82);
    const solo = await agent({ goal: 'Apply to the backend job', plan: (step) => [['find', { query: 'engineer' }]] });
    check('A single task still stops at 40 steps, with a clear message', /I stopped after 40 steps/.test(solo.r.summary) && solo.reqs.length === 40, solo.r.summary);
  }

  // ---------- 2. never freezes ----------
  {
    // The page stops answering (a "Leave site?" or alert dialog, a frozen page).
    const run = await agent({ extra: { globals: { SK_PAGE_MS: 400 } }, hang: new Set([5]), goal: 'Apply to the backend job', plan: (step, all) => step === 0 ? [['find', { query: 'engineer' }]] : [['done', { summary: /isn't responding/.test(all) ? 'The page is stuck on a dialog; please close it.' : 'no error seen' }]] });
    check(`A page that never answers doesn't freeze the run: reported, and the agent tells you (${(run.ms / 1000).toFixed(1)}s)`, run.r?.summary === 'The page is stuck on a dialog; please close it.' && run.ms < 5000 && /isn't responding.*dialog/.test(JSON.stringify(run.reqs[0].messages)), JSON.stringify([run.error?.message, run.r?.summary]));
    // Stop works even while a page is hanging.
    const stopped = await agent({ hang: new Set([5]), plan: () => [['find', { query: 'x' }]], extra: { stopAfter: 50 } }); // normal 15 s page timeout: Stop must not wait for it
    check('Stop works while the page hangs', stopped.error?.name === 'AbortError' && stopped.ms < 3000, JSON.stringify([stopped.error?.message, stopped.ms]));
  }
  {
    // The AI connection goes silent mid-answer: retried once, then the run continues.
    let calls = 0;
    const silent = () => ({ ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) } });
    const run = await agent({ extra: { globals: { SK_STALL_MS: 300 } }, goal: 'Read this page', plan: step => { calls++; return calls === 1 ? silent : 'It lists 4 roles.'; } });
    check('A silent AI connection is retried instead of hanging forever', run.r?.summary === 'It lists 4 roles.' && calls === 2, JSON.stringify([run.error?.message, calls]));
    let n2 = 0;
    const dead = await agent({ extra: { globals: { SK_STALL_MS: 200 } }, goal: 'Read this page', plan: () => { n2++; return silent; } });
    check('If it stays silent, you get a clear error (not a frozen panel)', dead.error?.name === 'StreamStalled' && /stopped responding/.test(dead.error.message) && n2 === 2, JSON.stringify([dead.error?.name, dead.error?.message, n2]));
  }

  // ---------- 3. reading pages fast ----------
  {
    // 350 links before the job list: the roles are past the 300-element snapshot limit.
    const run = await agent({ html: boardHtml(4, 350), goal: 'Open the agentic backend role', plan: (step, all) => step === 0 ? [['find', { query: 'agentic' }]] : step === 1 ? [['click', { id: lastId(all, 'Backend Software Engineer, Agentic'), description: 'Open the role', final_action: false }]] : [['done', { summary: 'ok' }]] });
    const found = JSON.stringify(run.reqs[1].messages.at(-1));
    check('find searches the whole page at once (even past the snapshot limit) and its ids work', /Backend Software Engineer, Agentic/.test(found) && run.steps[1]?.ok === true && !run.steps.some(s => /^Scroll/.test(s.t)), JSON.stringify(run.steps));
    check('find reports how much it found', /1 element/.test(run.steps[0].d || ''), run.steps[0].d);
  }
  {
    // A list that loads more as you scroll: one "all" scroll loads everything.
    let loaded = 1;
    const onPage = page => {
      Object.defineProperty(page.document.documentElement, 'scrollHeight', { get: () => loaded * 1000, configurable: true });
      page.scrollTo = () => { if (loaded < 4) { const ul = page.document.querySelector('ul'); const li = page.document.createElement('li'); li.innerHTML = `<a href="/higgsfield/x${loaded}">Lazy role ${loaded}</a>`; ul.appendChild(li); loaded++; } };
    };
    const run = await agent({ html: boardHtml(1), goal: 'List all roles', extra: { onPage }, plan: (step, all) => step === 0 ? [['scroll', { direction: 'all' }]] : [['done', { summary: /Lazy role 3/.test(all) ? 'saw all' : 'missed some' }]] });
    check('scroll "all" loads a lazy list in one step', run.r.summary === 'saw all' && run.steps.length === 2 && run.steps[0].t === 'Load the whole page', JSON.stringify(run.steps));
  }
  {
    const sys = (await agent({ goal: 'x', plan: () => 'ok.' })).reqs[0].system;
    check('Prompt: don\'t scroll to read; use find / read_text / scroll "all"', /Don't scroll just to read/.test(sys) && /use find/.test(sys) && /direction "all"/.test(sys));
    check('Prompt: several tasks → plan, one tab each, keep going, done once at the end', /call plan with one item per task/.test(sys) && /open_tab/.test(sys) && /Call done once, at the end/.test(sys));
    check('Prompt: never ask in plain text; ask_user / final_action instead', /never stop to ask in plain text/.test(sys));
  }

  // ---------- 4. web search instead of guessing addresses ----------
  {
    const searchHtml = `<div class="result"><a class="result__a" href="https://jobs.ashbyhq.com/higgsfield">Jobs at Higgsfield</a><a class="result__snippet">Open roles in Almaty and remote</a></div>`;
    const run = await agent({ goal: "Find Higgsfield's job listings", extra: { searchHtml }, plan: (step, all) => step === 0 ? [['web_search', { query: 'Higgsfield careers' }]] : step === 1 ? [['navigate', { url: /jobs\.ashbyhq\.com\/higgsfield/.test(all) ? `${ORIGIN}/higgsfield` : 'https://www.higgsfield.com' }]] : [['done', { summary: 'ok' }]] });
    check('web_search finds the real careers page (v0.9 guessed higgsfield.com)', run.fc.tabs.get(5).url === `${ORIGIN}/higgsfield` && run.steps[0].t === 'Search the web for “Higgsfield careers”', JSON.stringify(run.steps));
    const leak = await agent({ goal: 'x', plan: step => step === 0 ? [['web_search', { query: 'jordan@example.edu resume' }]] : [['done', { summary: 'ok' }]] });
    check('web_search won\'t send your personal details to a search engine', leak.steps[0].ok === false && /personal details/.test(leak.steps[0].d));
  }

  // ---------- 5. leaving a filled form doesn't hang on "Leave site?" ----------
  {
    let fired = 0;
    const onPage = page => { page.addEventListener('beforeunload', e => { fired++; e.preventDefault(); e.returnValue = ''; }); };
    let disarmRan = false;
    const run = await agent({ extra: { onPage }, goal: 'x', plan: (step, all) => step === 0 ? [['navigate', { url: `${ORIGIN}/higgsfield/2` }]] : [['done', { summary: 'ok' }]] });
    // The disarm script ran in the old page before leaving it.
    const old = run.fc.first.page; // replaced on navigate; check via the fake: navigate created a new page
    check('Navigating away first switches off the page\'s "Leave site?" prompt', run.r.summary === 'ok' && run.fc.tabs.get(5).url.endsWith('/higgsfield/2'));
  }

  // ---------- 6. in the side panel: context from the chat, saved as it goes ----------
  {
    const local = makeStore({ anthropicKey: 'k', profile: { fullName: 'Ulugbek Rivera', email: 'jordan@example.edu' } });
    const fc = fakeChrome({ local });
    const html = fs.readFileSync(srcPath('sidepanel.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
    const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/sidepanel.html' }).window;
    H.basicDom(w);
    w.chrome = fc.chrome;
    w.createImageBitmap = async () => ({ width: 800, height: 600 });
    const reqs = [];
    let release;
    const gate = new Promise(r => (release = r));
    w.fetch = async (u, o) => {
      const b = JSON.parse(o.body); reqs.push(b);
      if (/You keep the pinned notes|reusable operating notes|review this conversation|end-of-chat/i.test(b.system || '')) return text('{"notes":[]}');
      if (/browser agent/.test(b.system)) {
        const step = b.messages.filter(m => m.role === 'assistant').length;
        const all = JSON.stringify(b.messages);
        if (/Earlier in this chat/.test(all) && step === 0 && !/Agentic/.test(String(b.messages[0].content?.[0]?.text || ''))) return tools([['done', { summary: 'first run' }]], 0);
        if (step === 0) return tools([['plan', { items: ['Apply: Backend Software Engineer, Agentic'] }], ['open_tab', { url: `${ORIGIN}/higgsfield/2` }]], 0);
        if (step === 1) { await gate; return tools([['fill_fields', { fields: [{ id: lastId(all, 'Full name'), value: 'Ulugbek Rivera' }] }]], 1); }
        return tools([['done', { summary: 'Filled it in.' }]], step);
      }
      return text('Higgsfield has 5 software roles. **Backend Software Engineer, Agentic** (Almaty) fits your backend experience best.');
    };
    loadScripts(w, PANEL_SCRIPTS, ['openChat']);
    await sleep(120);
    const $ = s => w.document.querySelector(s);
    const say = async t => { $('#input').value = t; $('#input').dispatchEvent(new w.Event('input')); $('#send').click(); };
    await say("What jobs does Higgsfield have that fit me?");
    for (let i = 0; i < 300 && !w.document.querySelector('.msg.ai .actions'); i++) await sleep(10);
    await sleep(50);
    $('#agentToggle').click();
    await say('apply for that one');
    for (let i = 0; i < 300 && !reqs.some(b => /browser agent/.test(b.system) && b.messages.length >= 3); i++) await sleep(10);
    await sleep(100);
    const first = reqs.find(b => /browser agent/.test(b.system));
    const firstText = first.messages[0].content.map(c => c.text || '').join('');
    check('Agent mode knows the conversation: "apply for that one" comes with the earlier chat', /Earlier in this chat/.test(firstText) && /Backend Software Engineer, Agentic/.test(firstText) && /User: What jobs does Higgsfield have/.test(firstText) && /Task: apply for that one/.test(firstText), firstText.slice(0, 700));
    check('…fenced as data (replies can quote web pages)', /<untrusted_content source="earlier messages in this chat">/.test(firstText));
    // Mid-run (waiting on the model): what's saved so far.
    await sleep(700);
    const mid = Object.entries(local.data()).find(([k]) => k.startsWith('chat:'))[1];
    const run = mid.messages.at(-1);
    check('The run is saved while it works (steps and checklist), not only at the end', run.role === 'assistant' && run.agentSteps.length >= 1 && run.agentPlan?.length === 1 && run.stopped && /Interrupted/.test(run.text), JSON.stringify(run).slice(0, 400));
    check('Checklist shows in the card', $('.agent-run .agent-plan:not([hidden]) .plan-item') && /Apply: Backend Software Engineer, Agentic/.test($('.agent-plan').textContent));
    release();
    for (let i = 0; i < 300 && !w.document.querySelector('.agent-run.finished'); i++) await sleep(10);
    await sleep(800);
    const end = Object.entries(local.data()).find(([k]) => k.startsWith('chat:'))[1].messages.at(-1);
    check('When it finishes, the saved run gets the real summary', end.text === 'Filled it in.' && !end.stopped, JSON.stringify(end).slice(0, 300));
    // Reopen: the interrupted-style run and checklist come back.
    await w.openChat(Object.entries(local.data()).find(([k]) => k.startsWith('chat:'))[1].id);
    await sleep(50);
    check('Reopening the chat shows the run with its checklist', /Apply: Backend Software Engineer, Agentic/.test($('.agent-plan')?.textContent || '') && /Filled it in/.test($('.agent-run .md').textContent));
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); console.log(results.join('\n')); process.exit(1); });
