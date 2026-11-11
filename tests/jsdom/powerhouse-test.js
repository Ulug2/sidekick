// v1 Phase 6: the Powerhouse page. Drives the state machine idle → dispatch → thinking → working →
// needs you → done/failed → paused (by him, by the spend cap) through storage, as the orchestrator
// writes it, and checks the DOM: Sidekick's pose, the shout and its trace, the figures, the worker
// list (the accessible path), the drawer (focus in and back, Escape, inert), Pause/Resume, text-only
// rendering of web text, overflow. Storage is faked; no model is called.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, sleep, makeStore, loadScripts, fs, srcPath } = H;
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 900).replace(/\n/g, '\n        ') : ''}`);

(async () => {
  const local = makeStore({ jobSettings: { dailyCap: 20, monthlyCap: 25, batchHour: 8 } });
  const session = makeStore();
  const html = fs.readFileSync(srcPath('powerhouse.html'), 'utf8');
  const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/powerhouse.html' }).window;
  w.chrome = { storage: { local, session, onChanged: { addListener() {} } }, runtime: { getURL: p => p }, tabs: { update: async () => ({ windowId: 1 }) }, windows: { update: async () => {} } };
  if (!w.crypto.randomUUID) w.crypto.randomUUID = () => require('crypto').randomUUID();
  loadScripts(w, ['ui/powerhouse/powerhouse.js'], ['refresh', 'setVoiceProvider']);
  const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
  const spoken = []; w.setVoiceProvider({ speak: t => spoken.push(t) });
  const now = () => Date.now();
  const rec = (o) => ({ n: 1, kind: 'apply', title: 'Apply: Software Engineer at Stripe', model: 'claude-haiku-5-5', status: 'working', step: 'Starting', startedAt: now(), updatedAt: now(), cost: 0, ...o });
  const set = async (orchestrator, brainCalls = []) => { await local.set({ orchestrator }); await session.set({ brainCalls }); await w.refresh(); await sleep(20); };
  const fig = id => $$('#figures > g').find(g => g.dataset.id === id);
  const pose = id => fig(id)?.querySelector('use')?.getAttribute('href');
  const listText = () => $$('#workerList li').map(li => li.textContent.replace(/\s+/g, ' ').trim());
  await sleep(80);

  // ---- idle ----
  await set({});
  check('Idle: Sidekick stands, no figures, the list says why it is empty, the chip says when the next batch is', $('#coach').dataset.coach === 'idle' && !$$('#figures > g').length && !$('#emptyList').hidden && /^Sleeping until \d{1,2}:00 (AM|PM) ET$/.test($('#chip').textContent) && $('#bubble').hidden && $('#wire').hasAttribute('hidden') && listText().length === 1, $('#chip').textContent);

  // ---- dispatch: a worker starts; Sidekick shouts its real title, the trace runs to it ----
  await set({ workers: [rec({ id: 'w1' })], lastShout: { text: 'Agent 1! Apply: Software Engineer at Stripe', at: now(), workerId: 'w1' } });
  check('Dispatch: Sidekick shouts the task\'s real title in the bubble, the trace runs to Agent 1, the voice hook gets the same text', $('#coach').dataset.coach === 'shouting' && !$('#bubble').hidden && $('#bubble').textContent === 'Agent 1! Apply: Software Engineer at Stripe' && !$('#wire').hasAttribute('hidden') && /^M738 634 V740 H262 V/.test($('#wire').getAttribute('d')) && spoken.join('|') === 'Agent 1! Apply: Software Engineer at Stripe', JSON.stringify({ coach: $('#coach').dataset.coach, d: $('#wire').getAttribute('d'), spoken }));
  check('Agent 1 does pull-ups at the bar (it is applying), animated, numbered', pose('w1') === '#p-pull' && fig('w1').classList.contains('anim') && fig('w1').querySelector('.badge text').textContent === '1' && /translate\(262 760\)/.test(fig('w1').getAttribute('transform')) && $('#chip').textContent === 'Running · 1 working');

  // ---- a brain call in flight: push-ups win over the shout ----
  await set({ workers: [rec({ id: 'w1' })], lastShout: { text: 'Agent 1! x', at: now(), workerId: 'w1' } }, [{ id: 'b1', what: 'Pick the best 18 to apply to today', startedAt: now() }]);
  check('Brain call in flight: Sidekick does push-ups and the page says what he is thinking about', $('#coach').dataset.coach === 'thinking' && /thinking: Pick the best 18/.test($('#thinking').textContent));
  await set({ workers: [rec({ id: 'w1' })] }, [{ id: 'b1', what: 'old', startedAt: now() - 4 * 60000 }]);
  check('A brain call older than 3 minutes (page closed mid-call) no longer counts', $('#coach').dataset.coach === 'idle' && !$('#thinking').textContent);

  // ---- working: the shout is over; a writer joins ----
  await set({ workers: [rec({ id: 'w1', step: 'Page 2: Education' }), rec({ id: 'w2', n: 2, kind: 'write', title: 'Cover letter: Stripe', step: 'Writing', startedAt: now() + 1 })], lastShout: { text: 'Agent 1! x', at: now() - 7000, workerId: 'w1' } });
  check('Working: the 6-second shout is over; Agent 2 (writing) does sit-ups on the mat', $('#coach').dataset.coach === 'idle' && $('#bubble').hidden && pose('w2') === '#p-situp' && fig('w2').classList.contains('anim') && $('#chip').textContent === 'Running · 2 working');
  check('The list is the accessible path: Sidekick first, then each agent with what it is doing', listText().length === 3 && /^S\s*Sidekick/.test(listText()[0]) && /Apply: Software Engineer at Stripe.*Page 2: Education.*applying/.test(listText()[1]) && /Cover letter: Stripe.*writing/.test(listText()[2]) && $$('#workerList button').every(b => b.getAttribute('aria-label')) && $('#scene').getAttribute('aria-hidden') === 'true', JSON.stringify(listText()));

  // ---- needs you ----
  await set({ workers: [rec({ id: 'w1', status: 'needs_you', step: 'Waiting for you' }), rec({ id: 'w2', n: 2, kind: 'write', title: 'Cover letter: Stripe', startedAt: now() + 1 })], needsYou: [{ workerId: 'w1', jobId: 'j1', since: now(), stoppedAt: '', questions: [] }] });
  check('Needs you: Agent 1 sits on the bench with a hand up and a "?", not animated; the chip counts it', pose('w1') === '#p-raise' && fig('w1').classList.contains('wave') && !fig('w1').classList.contains('anim') && fig('w1').querySelector('.tag-q') && /translate\(1290 668\)/.test(fig('w1').getAttribute('transform')) && $('#chip').textContent === 'Running · 1 working · 1 needs you' && /needs you/.test(listText()[1]));

  // ---- done and failed ----
  await set({ workers: [rec({ id: 'w1', status: 'done', step: 'Submitted', updatedAt: now() }), rec({ id: 'w2', n: 2, kind: 'write', status: 'failed', error: 'Spend cap reached <b>x</b>', startedAt: now() + 1 })] });
  check('Done: Agent 1 sits on the bench with a "done" tag; failed: Agent 2 slumps with a "!" and the error in the list', pose('w1') === '#p-sit' && /done/.test(fig('w1').textContent) && pose('w2') === '#p-slump' && fig('w2').querySelector('.tag-err') && /Error: Spend cap reached <b>x<\/b>/.test(listText()[2]) && !$('#workerList b'), JSON.stringify(listText()));
  await set({ workers: [rec({ id: 'w1', status: 'done', updatedAt: now() - 31000 }), rec({ id: 'w2', n: 2, kind: 'write', title: 'Cover letter: Stripe', status: 'failed', error: 'x', updatedAt: now() - 31000, startedAt: now() + 1 })] });
  check('30 seconds after it finished, a done worker leaves; a failed one stays until dismissed', !fig('w1') && fig('w2') && listText().length === 2);

  // ---- keyboard focus survives a refresh (rows are rebuilt on every storage change) ----
  $$('#workerList button').find(b => b.dataset.open === 'w2').focus();
  await w.refresh(); await sleep(20);
  check('A refresh keeps keyboard focus on the same row', w.document.activeElement?.dataset?.open === 'w2');

  // ---- the drawer: focus in, Escape, focus back, Dismiss ----
  const b2 = $$('#workerList button').find(b => b.dataset.open === 'w2');
  b2.focus(); b2.click(); await sleep(20);
  check('Drawer: opens for Agent 2 with its error, takes focus, is no longer inert', $('#drawer').classList.contains('open') && !$('#drawer').inert && w.document.activeElement === $('#closeDrawer') && /Agent 2 · Cover letter: Stripe/.test($('#drawerTitle').textContent) && /Error: x/.test($('#drawerBody').textContent), JSON.stringify({ open: $('#drawer').className, inert: $('#drawer').inert, active: w.document.activeElement?.id, title: $('#drawerTitle').textContent, body: $('#drawerBody').textContent }));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(20);
  check('Escape closes it, makes it inert again and returns focus to the list item', !$('#drawer').classList.contains('open') && $('#drawer').inert && w.document.activeElement?.dataset.open === 'w2');
  $$('#workerList button').find(b => b.dataset.open === 'w2').click(); await sleep(20);
  [...$('#drawerActions').querySelectorAll('button')].find(b => b.textContent === 'Dismiss').click(); await sleep(50); await w.refresh(); await sleep(20);
  check('Dismiss clears a failed worker from the stage (stored, so it stays cleared)', local.data().orchestrator.dismissed.includes('w2') && !fig('w2'));

  // ---- paused by him ----
  await set({ workers: [rec({ id: 'w3', n: 3 })], paused: 'you' });
  check('Paused by you: Sidekick sits with "paused by you"; a running worker stops moving and says it is finishing this one; the button says Resume', $('#coach').dataset.coach === 'paused' && $('#coachTag').textContent === 'paused by you' && !fig('w3').classList.contains('anim') && /finishing/.test(fig('w3').textContent) && $('#pause').textContent === 'Resume' && $('#chip').textContent === 'Paused by you · 1 finishing');
  $('#pause').click(); await sleep(60);
  check('Resume clears the pause in storage', local.data().orchestrator.paused === null && $('#pause').textContent === 'Pause');
  await set({ workers: [], paused: 'spend-cap' });
  check('The old sticky "spend-cap" value is not a pause (the cap is read live)', $('#coach').dataset.coach === 'idle');

  // ---- spend cap, live ----
  await local.set({ capDaily: 1, usage: { [new Date().toLocaleDateString('en-CA')]: { 'claude-sonnet-5-5': { calls: 9, input: 400000, output: 30000, cacheRead: 0, cacheWrite: 0 } } } });
  await set({ workers: [] });
  check('Spend over the daily cap: Sidekick sits with "spend cap: daily", the chip says so, the meter shows it', $('#coach').dataset.coach === 'paused' && $('#coachTag').textContent === 'spend cap: daily' && $('#chip').textContent === 'Spend cap reached (daily)' && $('#chip').dataset.tone === 'warn' && $$('#meters .meter.over').length === 1);
  await local.set({ usage: {} });

  // ---- web text is text; overflow goes to the list ----
  const evil = 'Apply: <img src=x onerror="window.pwned=1"> at Evil';
  await set({ workers: [1, 2, 3, 4, 5].map(n => rec({ id: `a${n}`, n, title: n === 1 ? evil : `Apply: Job ${n}`, startedAt: now() + n })), lastShout: { text: `Agent 1! ${evil}`, at: now(), workerId: 'a1' } });
  check('Titles from job boards render as text (no element, no script)', !w.document.querySelector('#workerList img, #bubble img, #figures img') && $('#bubble').textContent.includes('<img') && !w.pwned);
  check('More workers than slots: 3 at the bar, a "+2 more below" chip, all 5 on the list', $$('#figures > g').length === 3 && !$('#moreChip').hasAttribute('hidden') && $('#moreText').textContent === '+2 more below' && listText().length === 6);

  console.log(results.join('\n'));
  const passed = results.filter(x => x.startsWith('PASS')).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.log(results.join('\n')); console.log('CRASH', e.stack); process.exit(1); });
