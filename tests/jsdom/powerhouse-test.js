// v1 Phase 6: the Powerhouse page. Drives the state machine idle → dispatch → thinking → working →
// needs you → done/failed → paused (by him, by the spend cap) through storage, as the orchestrator
// writes it, and checks the DOM: Sidekick's state, the shout, each worker's label (pose, part of the
// card, state), the worker list (the accessible path), the drawer (focus in and back, Escape, inert),
// Pause/Resume, text-only rendering of web text, overflow. jsdom has no WebGL, so the 3D view runs
// its no-WebGL path (labels and a note; the drawing itself is checked in real Chromium, 9b).
// Storage is faked; no model is called.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, sleep, makeStore, loadScripts, fs, srcPath } = H;
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 900).replace(/\n/g, '\n        ') : ''}`);

(async () => {
  const local = makeStore({ jobSettings: { dailyCap: 20, monthlyCap: 25, batchHour: 8 } });
  const session = makeStore();
  const html = fs.readFileSync(srcPath('powerhouse.html'), 'utf8');
  const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/powerhouse.html' }).window;
  w.chrome = { storage: { local, session, onChanged: { addListener() {} } }, runtime: { getURL: p => p }, tabs: { update: async () => ({ windowId: 1 }) }, windows: { update: async () => {} } };
  w.ResizeObserver = class { observe() {} };
  if (!w.crypto.randomUUID) w.crypto.randomUUID = () => require('crypto').randomUUID();
  loadScripts(w, ['ui/powerhouse/powerhouse.js'], ['refresh', 'setVoiceProvider']);
  const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
  const spoken = []; w.setVoiceProvider({ speak: t => spoken.push(t) });
  const now = () => Date.now();
  const rec = (o) => ({ n: 1, kind: 'apply', title: 'Apply: Software Engineer at Stripe', model: 'm', status: 'working', step: 'Starting', startedAt: now(), updatedAt: now(), cost: 0, ...o });
  const set = async (orchestrator, brainCalls = []) => { await local.set({ orchestrator }); await session.set({ brainCalls }); await w.refresh(); await sleep(20); };
  const mode = () => $('#overlay').dataset.mode;
  const line = () => $('#thinking').textContent;
  const listText = () => $$('#workerList li').map(li => li.textContent.replace(/\s+/g, ' ').trim());
  await sleep(80);

  // ---- no WebGL (jsdom): the stage says so in one line; everything below still works ----
  check('Without WebGL the stage says so in one line, no canvas, and the list carries everything', !!$('.stage .nogl') && /3D view is off because WebGL is not available/.test($('.stage .nogl').textContent) && !$('.ph-canvas'));

  // ---- idle ----
  await set({});
  check('Idle: everyone is asleep (Sidekick sleeps on the roof), no workers, the list says why it is empty, the chip says when the next batch is', mode() === 'sleep' && /^Everyone is asleep\. The next batch is built at/.test(line()) && /Sleeping on the HQ roof/.test(listText()[0]) && !$('#emptyList').hidden && /^Sleeping until \d{1,2}:00 (AM|PM) ET$/.test($('#chip').textContent) && listText().length === 1, $('#chip').textContent);

  // ---- dispatch: a worker starts; Sidekick names its real title ----
  await set({ workers: [rec({ id: 'w1' })], lastShout: { text: 'Agent 1! Apply: Software Engineer at Stripe', at: now(), workerId: 'w1' } });
  check('Dispatch: Sidekick whistles, the status line names the worker and its real title, the voice hook gets it, the worker is "starting"', mode() === 'whistle' && line() === 'Sidekick started worker 1: Apply: Software Engineer at Stripe' && spoken.join('|') === 'Agent 1! Apply: Software Engineer at Stripe' && /starting/.test(listText()[1]) && $('#chip').textContent === 'Running · 1 working', JSON.stringify({ mode: mode(), line: line(), spoken }));

  // ---- a brain call in flight ----
  await set({ workers: [rec({ id: 'w1' })], lastShout: { text: 'Agent 1! x', at: now(), workerId: 'w1' } }, [{ id: 'b1', what: 'Pick the best 18 to apply to today', startedAt: now() }]);
  check('A brain call and a fresh dispatch at once: the dispatch wins (it explains the new robot)', mode() === 'whistle' && /^Sidekick started worker 1:/.test(line()), line());
  await set({ workers: [rec({ id: 'w1' })] }, [{ id: 'b1', what: 'Pick the best 18 to apply to today', startedAt: now() }]);
  check('Brain call in flight: Sidekick lifts and the page says what he is thinking about', mode() === 'lift' && /^Sidekick is thinking: Pick the best 18/.test(line()) && /lifting on the HQ roof/.test(listText()[0]), line());
  await set({ workers: [rec({ id: 'w1' })] }, [{ id: 'b1', what: 'old', startedAt: now() - 4 * 60000 }]);
  check('A brain call older than 3 minutes (page closed mid-call) no longer counts: Sidekick coaches', mode() === 'coach' && /^Sidekick is coaching: 1 worker is on the job\.$/.test(line()), line());

  // ---- working: the 6-second dispatch is over; a writer joins ----
  await set({ workers: [rec({ id: 'w1', step: 'Page 2: Education' }), rec({ id: 'w2', n: 2, kind: 'write', title: 'Cover letter: Stripe', step: 'Writing', startedAt: now() + 1 })], lastShout: { text: 'Agent 1! x', at: now() - 7000, workerId: 'w1' } });
  check('Working: the dispatch is over; Agent 1 applying, Agent 2 writing', mode() === 'coach' && /applying/.test(listText()[1]) && /writing/.test(listText()[2]) && $('#chip').textContent === 'Running · 2 working');
  check('The list is the accessible path: Sidekick first, then each agent with what it is doing; the 3D layer is hidden from screen readers', listText().length === 3 && /^S\s*Sidekick/.test(listText()[0]) && /Apply: Software Engineer at Stripe.*Page 2: Education.*applying/.test(listText()[1]) && /Cover letter: Stripe.*writing/.test(listText()[2]) && $$('#workerList button').every(b => b.getAttribute('aria-label')) && $('#overlay').getAttribute('aria-hidden') === 'true', JSON.stringify(listText()));

  // ---- needs you ----
  await set({ workers: [rec({ id: 'w1', status: 'needs_you', step: 'Waiting for you' }), rec({ id: 'w2', n: 2, kind: 'write', title: 'Cover letter: Stripe', startedAt: now() + 1 })], needsYou: [{ workerId: 'w1', jobId: 'j1', since: now(), stoppedAt: '', questions: [] }] });
  check('Needs you: Agent 1 needs you (amber pill); the chip counts it', $$('#workerList .wl-state')[1].textContent === 'needs you' && $$('#workerList .wl-state')[1].dataset.tone === 'amber' && $('#chip').textContent === 'Running · 1 working · 1 needs you');

  // ---- done and failed ----
  await set({ workers: [rec({ id: 'w1', status: 'done', step: 'Submitted', updatedAt: now() }), rec({ id: 'w2', n: 2, kind: 'write', status: 'failed', error: 'Spend cap reached <b>x</b>', startedAt: now() + 1 })] });
  check('Done (grey) and failed (red, the error as plain text in the list)', /done/.test(listText()[1]) && $$('#workerList .wl-state')[2].dataset.tone === 'red' && /Error: Spend cap reached <b>x<\/b>/.test(listText()[2]) && !$('#workerList b'), JSON.stringify(listText()));
  await set({ workers: [rec({ id: 'w1', status: 'done', updatedAt: now() - 31000 }), rec({ id: 'w2', n: 2, kind: 'write', title: 'Cover letter: Stripe', status: 'failed', error: 'x', updatedAt: now() - 31000, startedAt: now() + 1 })] });
  check('30 seconds after it finished, a done worker leaves; a failed one stays until dismissed', listText().length === 2 && /Cover letter: Stripe/.test(listText()[1]));

  // ---- keyboard focus survives a refresh (rows are rebuilt on every storage change) ----
  $$('#workerList button').find(b => b.dataset.open === 'w2').focus();
  await w.refresh(); await sleep(20);
  check('A refresh keeps keyboard focus on the same row', w.document.activeElement?.dataset?.open === 'w2');

  // ---- the drawer: focus in, Escape, focus back, Dismiss ----
  const b2 = $$('#workerList button').find(b => b.dataset.open === 'w2');
  b2.focus(); b2.click(); await sleep(20);
  check('Drawer: opens for Agent 2 with its error, takes focus, is no longer inert', $('#drawer').classList.contains('open') && !$('#drawer').inert && w.document.activeElement === $('#closeDrawer') && /Agent 2 · Cover letter: Stripe/.test($('#drawerTitle').textContent) && /Error: x/.test($('#drawerBody').textContent));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(20);
  check('Escape closes it, makes it inert again and returns focus to the list item', !$('#drawer').classList.contains('open') && $('#drawer').inert && w.document.activeElement?.dataset.open === 'w2');
  $$('#workerList button').find(b => b.dataset.open === 'w2').click(); await sleep(20);
  [...$('#drawerActions').querySelectorAll('button')].find(b => b.textContent === 'Dismiss').click(); await sleep(50); await w.refresh(); await sleep(20);
  check('Dismiss clears a failed worker (stored, so it stays cleared)', local.data().orchestrator.dismissed.includes('w2') && listText().length === 1);

  // ---- paused by him ----
  await set({ workers: [rec({ id: 'w3', n: 3 })], paused: 'you' });
  check('Paused by you: Sidekick rests; a running worker is finishing this one (gold); the button says Resume', mode() === 'rest' && /Paused by you/.test(listText()[0]) && /finishing/.test(listText()[1]) && $$('#workerList .wl-state')[1].dataset.tone === 'gold' && $('#pause').textContent === 'Resume' && $('#chip').textContent === 'Paused by you · 1 finishing' && line() === 'Paused. Workers finish the job they are on; nothing new starts.');
  $('#pause').click(); await sleep(60);
  check('Resume clears the pause in storage', local.data().orchestrator.paused === null && $('#pause').textContent === 'Pause');
  await set({ workers: [], paused: 'spend-cap' });
  check('The old sticky "spend-cap" value is not a pause (the cap is read live)', mode() === 'sleep');

  // ---- spend cap, live ----
  await local.set({ capDaily: 1, usage: { [new Date().toLocaleDateString('en-CA')]: { 'claude-sonnet-5-5': { calls: 9, input: 400000, output: 30000, cacheRead: 0, cacheWrite: 0 } } } });
  await set({ workers: [] });
  check('Spend over the daily cap: Sidekick rests, the chip says so, the meter shows it', mode() === 'rest' && /Paused: spend cap/.test(listText()[0]) && /^Spend cap reached\./.test(line()) && $('#chip').textContent === 'Spend cap reached (daily)' && $('#chip').dataset.tone === 'warn' && $$('#meters .meter.over').length === 1);
  await local.set({ usage: {} });

  // ---- web text is text; overflow goes to the list ----
  const evil = 'Apply: <img src=x onerror="window.pwned=1"> at Evil';
  await set({ workers: [1, 2, 3, 4, 5].map(n => rec({ id: `a${n}`, n, title: n === 1 ? evil : `Apply: Job ${n}`, startedAt: now() + n })), lastShout: { text: `Agent 1! ${evil}`, at: now(), workerId: 'a1' } });
  check('Titles from job boards render as text (no element, no script) in the list and the status line', !w.document.querySelector('#workerList img, .stage img, #drawer img, #thinking img') && line().includes('<img') && listText()[1].includes('<img') && !w.pwned);
  await set({ workers: [1, 2, 3, 4, 5, 6].map(n => rec({ id: `a${n}`, n, title: `Apply: Job ${n}`, startedAt: now() + n })) });
  check('More couriers than the lane holds (4): 2 more are only in the list, and all 6 are listed', /^2 more workers than there is room for on the card/.test(line()) && listText().length === 7, line());

  console.log(results.join('\n'));
  const passed = results.filter(x => x.startsWith('PASS')).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.log(results.join('\n')); console.log('CRASH', e.stack); process.exit(1); });
