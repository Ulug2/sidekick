// Run traces (Phase F): every agent step is recorded and saved as it happens, with cost from the
// price table; the Agent runs page replays a run, and export/import works without leaking secrets
// or rendering page content as HTML.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, makeStore, sseResponse, anthropicEvents, loadScripts, fs, srcPath } = H;
const { prep } = require(require('path').join(__dirname, 'engine-test.js'));
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 1500).replace(/\n/g, '\n        ') : ''}`);
const AGENT = ['ai.js', 'guard.js', 'profile-core.js', 'memory.js', 'skills.js', 'docs.js', 'web.js', 'screen.js', 'page-agent.js', 'cdp.js', 'adapters.js', 'agent.js'];
const SHOT = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 };
// claude-sonnet-5-5: $2 in, $10 out, $0.20 cache read per million tokens.
const SONNET_CALL = (1000 * 2 + 200 * 10 + 500 * 0.2) / 1e6;
const FORM = `<!doctype html><html><head><title>Contact form</title></head><body><main><h1>Contact us</h1>
  <form onsubmit="return false"><label for="n">Your name</label><input id="n"><button type="button" id="s" onclick="window.sent=(window.sent||0)+1;document.querySelector('main').innerHTML='<h1>Thanks!</h1>'">Send message</button></form></main></body></html>`;
const lastId = (all, label) => { const re = new RegExp(String.raw`\[(\d+)\] [a-z:]+ \\"` + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); let m, id = null; while ((m = re.exec(all))) id = m[1]; return id; };

// One tab with the form, a fake model that follows a script, and a fake screenshot.
async function agent({ script, goal = 'Send my name through the contact form', store = {}, approve = true, stopAt = null, onApprove }) {
  const local = makeStore({ anthropicKey: 'k', profile: { fullName: 'Ulugbek Rivera', email: 'jordan@example.edu' }, ...store });
  const url = 'https://acme.example/contact';
  const page = new JSDOM(FORM, { runScripts: 'dangerously', pretendToBeVisual: true, url }).window;
  prep(page);
  page.document.elementFromPoint = () => null;
  const tab = { id: 7, windowId: 1, active: true, status: 'complete', url };
  const ctl = new AbortController();
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/sidepanel.html' }).window;
  w.chrome = {
    storage: { local, session: makeStore(), onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ ...tab, title: page.document.title }], get: async () => ({ ...tab, title: page.document.title }),
      create: async () => { throw new Error('no new tabs here'); }, update: async () => ({ ...tab }), goBack: async () => {},
      onCreated: { addListener() {}, removeListener() {} }, onActivated: { addListener() {}, removeListener() {} },
      captureVisibleTab: async () => SHOT, group: async () => 1
    },
    tabGroups: { update: async () => ({}) },
    scripting: { executeScript: async ({ func, args }) => [{ frameId: 0, result: JSON.parse(JSON.stringify((await page.eval(`(${func.toString()})`)(...(args || []))) ?? null)) }] },
    debugger: { attach: async () => { throw new Error('no debugger here'); }, detach: async () => {}, onDetach: { addListener() {}, removeListener() {} }, sendCommand: async () => ({}) },
    runtime: { getURL: p => p, getManifest: () => ({ version: '0.9.6' }) }
  };
  // shrinkImage: a picture already small enough is kept as is (no canvas needed).
  w.createImageBitmap = async () => ({ width: 800, height: 500 });
  const reqs = [];
  w.fetch = async (u, o) => {
    if (String(u).startsWith('data:')) return { blob: async () => new w.Blob(['x']) };
    const body = JSON.parse(o.body); reqs.push(body);
    if (/You check one step of a browser agent/.test(body.system || '')) return sseResponse(anthropicEvents([{ type: 'text', text: '{"verdict":"ok","reason":"fits"}' }], { usage: { input_tokens: 300, output_tokens: 10 } }));
    if (/reusable operating notes/.test(body.system || '')) return sseResponse(anthropicEvents([{ type: 'text', text: '{"notes":[]}' }]));
    const step = body.messages.filter(m => m.role === 'assistant').length;
    if (stopAt === step) { ctl.abort(); throw new w.DOMException('Stopped', 'AbortError'); }
    const r = script[step](JSON.stringify(body.messages));
    if (r instanceof Error) return new Response(JSON.stringify({ error: { message: r.message } }), { status: 400 });
    if (typeof r === 'string') return sseResponse(anthropicEvents([{ type: 'text', text: r }], { usage: USAGE }));
    return sseResponse(anthropicEvents(r.map(([name, input], k) => ({ type: 'tool_use', id: `t${step}_${k}`, name, input })), { stop: 'tool_use', usage: USAGE }));
  };
  loadScripts(w, AGENT, ['runAgent', 'listTraces', 'loadTrace', 'exportTrace', 'parseTraceExport', 'costOf']);
  const approvals = [];
  const ui = { signal: ctl.signal, step: () => ({ waiting() {}, done() {} }), note() {}, thinking() {}, plan() {}, ask: async () => 'ok',
    approve: async ({ title }) => { approvals.push(title); await onApprove?.(w); return approve; }, traceStarted: id => (ui.started = id) };
  let r, error;
  await w.runAgent(goal, ui, {}).then(x => (r = x), e => (error = e));
  return { r, error, w, local, page, reqs, approvals, ui };
}

const happy = [
  () => 'Shall I fill in your name and send it?', // asking in plain text: sent back to work (a nudge)
  all => [['type', { id: lastId(all, 'Your name'), text: 'Ulugbek Rivera' }], ['click', { id: lastId(all, 'Send message'), description: 'Send the message', final_action: true }]],
  () => [['done', { summary: 'Sent your name through the contact form.' }]]
];

(async () => {
  // ---------- 1. a finished run is recorded step by step ----------
  let midRun = null;
  const run = await agent({ script: happy, onApprove: async w => { await H.sleep(100); const [e] = (await w.chrome.storage.local.get('traceIndex')).traceIndex; midRun = (await w.chrome.storage.local.get(`trace:${e.id}`))[`trace:${e.id}`]; } });
  const index = (await run.local.get('traceIndex')).traceIndex || [];
  const t = index[0] && (await run.local.get(`trace:${index[0].id}`))[`trace:${index[0].id}`];
  check('The run finished and its trace is saved (one entry, outcome done, 3 steps)', !run.error && run.page.sent === 1 && index.length === 1 && t?.outcome === 'done' && t.steps.length === 3 && index[0].steps === 3 && index[0].outcome === 'done', JSON.stringify({ err: run.error?.message, index, outcome: t?.outcome, steps: t?.steps.length }));
  check('The run result and the panel both get the trace id', run.r?.traceId === t?.id && run.ui.started === t?.id);
  check('Step 1 records what the model was told (task + page) and its reply', /Task: Send my name/.test(t.steps[0].prompt) && /Contact us/.test(t.steps[0].prompt) && t.steps[0].model.text === 'Shall I fill in your name and send it?' && t.steps[0].actions.length === 0, JSON.stringify(t.steps[0]).slice(0, 600));
  check('The nudge sent back to the model is recorded as step 2\'s prompt', /A reply without a tool call ends the task/.test(t.steps[1].prompt || ''));
  const [typed, clicked] = t.steps[1].actions;
  check('Each action is recorded with its call, label, result and outcome', typed?.tool === 'type' && typed.ok && typed.args.text === 'Ulugbek Rivera' && /Your name/.test(typed.label) && clicked?.tool === 'click' && clicked.ok && clicked.label === 'Send the message' && /Thanks!/.test(clicked.result), JSON.stringify(t.steps[1].actions).slice(0, 800));
  check('The approval you gave is recorded with your answer', t.steps[1].events.some(e => e.kind === 'approve' && /Send message/.test(e.text) && e.answer === 'allowed'), JSON.stringify(t.steps[1].events));
  check('The model\'s calls are recorded with model, tokens and cost', t.steps.every(s => s.model?.model === 'claude-sonnet-5-5' && s.model.usage.input === 1000 && s.model.usage.output === 200 && Math.abs(s.model.cost - SONNET_CALL) < 1e-12), JSON.stringify(t.steps.map(s => s.model && { m: s.model.model, u: s.model.usage, c: s.model.cost })));
  const sideCost = t.steps.flatMap(s => s.side).reduce((a, c) => a + c.cost, 0);
  check('Totals add up every call of the run (agent steps and any checks), in dollars', t.totals.calls === 3 + t.steps.flatMap(s => s.side).length && Math.abs(t.totals.cost - (3 * SONNET_CALL + sideCost)) < 1e-12 && t.totals.costKnown && Math.abs(index[0].cost - t.totals.cost) < 1e-12, JSON.stringify(t.totals));
  check('A screenshot of the page is saved for each step (stored separately, once)', t.steps.every(s => s.shot && t.shotKeys.includes(s.shot)) && (await run.local.get(t.steps[0].shot))[t.steps[0].shot] === SHOT, JSON.stringify(t.steps.map(s => [s.shot, s.shotNote])));
  check('Each step records the page it started on', t.steps[0].url === 'https://acme.example/contact' && t.steps[0].title === 'Contact form' && t.steps[2].title === 'Contact form');
  check('Saved as it goes: while waiting for your approval, the steps so far, the decision and the open question are already stored', midRun?.outcome === 'running' && midRun.steps.length === 2 && midRun.steps[1].model?.toolCalls.length === 2 && midRun.steps[1].events.some(e => e.kind === 'approve' && e.answer === 'waiting…'), JSON.stringify({ outcome: midRun?.outcome, steps: midRun?.steps.length, ev: midRun?.steps[1]?.events }));
  check('The config is recorded (model, effort, approval mode)', t.config.model === 'claude-sonnet-5-5' && t.config.effort === 'medium' && t.config.approvalMode === 'final' && t.version === '0.9.6', JSON.stringify(t.config));

  // ---------- 2. stopped and failed runs keep their trace ----------
  {
    const stopped = await agent({ script: happy, stopAt: 1 });
    const [e] = (await stopped.local.get('traceIndex')).traceIndex;
    check('A stopped run is saved as "stopped" with the steps it got through', stopped.error?.name === 'AbortError' && e.outcome === 'stopped' && e.steps === 2, JSON.stringify({ err: stopped.error?.message, e }));
    const failed = await agent({ script: [() => new Error('model unavailable')] });
    const [f] = (await failed.local.get('traceIndex')).traceIndex;
    const ft = (await failed.local.get(`trace:${f.id}`))[`trace:${f.id}`];
    check('A run that hits an error is saved as "failed" with the error', !!failed.error && f.outcome === 'failed' && /model unavailable/.test(ft.error || ''), JSON.stringify({ err: failed.error?.message, f, e: ft?.error }));
    const off = await agent({ script: happy, store: { recordRuns: false } });
    const offData = off.local.data();
    check('With "Record agent runs" off, nothing is recorded', !off.error && !offData.traceIndex && !Object.keys(offData).some(k => k.startsWith('trace')) && !off.r.traceId);
  }

  // ---------- 3. only the last 30 runs are kept; cut-off runs are marked ----------
  {
    const seed = { traceIndex: [] };
    for (let i = 0; i < 30; i++) {
      const id = `old${i}`;
      seed.traceIndex.push({ id, goal: `old run ${i}`, startedAt: 1000 + i, outcome: i === 0 ? 'running' : 'done', steps: 1, cost: 0, costKnown: true, site: 'x' });
      seed[`trace:${id}`] = { id, goal: `old run ${i}`, outcome: i === 0 ? 'running' : 'done', steps: [], shotKeys: [`traceShot:${id}:1`], totals: {}, config: {}, start: {} };
      seed[`traceShot:${id}:1`] = SHOT;
    }
    const r = await agent({ script: happy, store: seed });
    const data = r.local.data();
    check('Only the last 30 runs are kept; the oldest one and its screenshots are deleted', data.traceIndex.length === 30 && !data.traceIndex.some(e => e.id === 'old29') && !('trace:old29' in data) && !('traceShot:old29:1' in data) && 'trace:old28' in data, JSON.stringify(data.traceIndex.map(e => e.id)));
    check('A run left "running" (panel closed mid-run) is marked interrupted', data.traceIndex.find(e => e.id === 'old0')?.outcome === 'interrupted' && data['trace:old0'].outcome === 'interrupted');
  }

  // ---------- 4. export and import ----------
  {
    const r = await agent({ script: happy, goal: 'Pay with card 4242 4242 4242 4242 on the contact form' });
    const [e] = (await r.local.get('traceIndex')).traceIndex;
    const exp = JSON.parse(JSON.stringify(await r.w.exportTrace(e.id)));
    check('Export: one file with the run and its screenshots', exp.format === 'sidekick-run' && exp.version === 1 && exp.trace.steps.length === 3 && Object.keys(exp.shots).length === 3 && Object.values(exp.shots).every(v => v === SHOT));
    check('Export masks card numbers and keys everywhere in the run', !JSON.stringify(exp).includes('4242 4242 4242 4242') && /hidden|•|\[/.test(exp.trace.goal), exp.trace.goal);
    const back = r.w.parseTraceExport(JSON.stringify(exp));
    check('An exported file opens again', back.trace.id === e.id && back.trace.steps.length === 3);
    let junk = '';
    try { r.w.parseTraceExport('{"hello":1}'); } catch (err) { junk = err.message; }
    let notJson = '';
    try { r.w.parseTraceExport('nope'); } catch (err) { notJson = err.message; }
    check('Files that aren\'t a run export are refused with a clear message', /isn't a Sidekick run export/.test(junk) && /not JSON/.test(notJson));
    const evil = r.w.parseTraceExport(JSON.stringify({ ...exp, shots: { a: 'javascript:alert(1)', b: 'data:image/svg+xml;base64,PHN2Zz4=', c: SHOT }, trace: { id: 'x', steps: [{}] } }));
    check('Imported files keep only JPEG/PNG images and get safe defaults for missing parts', Object.keys(evil.shots).join() === 'c' && evil.trace.config.model && Array.isArray(evil.trace.steps[0].actions) && evil.trace.steps[0].n === 1);
  }

  // ---------- 5. the Agent runs page ----------
  {
    const html = fs.readFileSync(srcPath('runs.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
    const t2 = JSON.parse(JSON.stringify(t));
    t2.goal = 'Apply <img src=x onerror="window.pwned=1"> now';
    t2.steps[1].actions[0].result = '<b>bold</b> <script>window.pwned=2</script>';
    const local = makeStore({ traceIndex: [{ ...index[0], goal: t2.goal }], [`trace:${t.id}`]: t2, ...Object.fromEntries(t.shotKeys.map(k => [k, SHOT])) });
    const w = new JSDOM(html, { runScripts: 'outside-only', url: `chrome-extension://abc/runs.html#${t.id}` }).window;
    w.chrome = { storage: { local }, runtime: { getURL: p => p } };
    w.HTMLElement.prototype.scrollIntoView = function () {};
    w.scrollTo = () => {};
    loadScripts(w, ['runs.js'], ['renderList']);
    await H.sleep(150);
    const doc = w.document;
    check('Runs page: the run opens from its link (#id) with its task, outcome and cost', !doc.querySelector('#runView').hidden && /Apply <img/.test(doc.querySelector('.run-title').textContent) && /Done/.test(doc.querySelector('.run-meta').textContent) && /\$0\.01/.test(doc.querySelector('.run-meta').textContent), doc.querySelector('#runView').textContent.slice(0, 400));
    check('Runs page: page content and model output are shown as text, never as HTML', !doc.querySelector('#runView img[src="x"]') && !doc.querySelector('#runView b') && !doc.querySelector('#runView script') && !w.pwned);
    check('Runs page: step 1 shows its screenshot, the prompt and the reply', doc.querySelector('#stage .shot img')?.getAttribute('src') === SHOT && /What the AI was told/.test(doc.querySelector('#stage').textContent) && /Shall I fill in your name/.test(doc.querySelector('#stage .said').textContent) && doc.querySelector('#stepCounter').textContent === 'Step 1 of 3');
    doc.querySelector('#nextStep').click();
    const stage = doc.querySelector('#stage').textContent;
    check('Runs page: next step shows the actions, the approval and your answer', doc.querySelector('#stepCounter').textContent === 'Step 2 of 3' && /Send message/.test(stage) && /Asked to approve → allowed/.test(stage) && doc.querySelectorAll('#stage .actions > li').length === 2, stage.slice(0, 600));
    check('Runs page: the step list marks the current step', doc.querySelectorAll('#stepList li').length === 3 && doc.querySelector('#stepList li.current .n').textContent === '2');
    w.location.hash = '';
    await H.sleep(150);
    check('Runs page: the list shows each run with outcome, steps and cost', !doc.querySelector('#listView').hidden && doc.querySelectorAll('#runList li').length === 1 && /3 steps/.test(doc.querySelector('#runList').textContent) && /Done/.test(doc.querySelector('#runList .pill').textContent) && !doc.querySelector('#runList img'));
    w.renderList([]);
    check('Runs page: with no runs, it says how to make one', /No runs recorded yet/.test(doc.querySelector('#listStatus').textContent));
  }

  console.log(results.join('\n'));
  const passed = results.filter(r => r.startsWith('PASS')).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
