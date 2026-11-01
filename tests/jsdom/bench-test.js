// The Benchmark page (Phase F item 4): tasks with their settings, Run hands the task to the side
// panel, grading, the score per version, and run results shown as text only.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, makeStore, loadScripts, fs, srcPath, sleep } = H;
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 1200).replace(/\n/g, '\n        ') : ''}`);

async function page(store = {}) {
  const html = fs.readFileSync(srcPath('bench.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const local = makeStore({ anthropicKey: 'k', ...store });
  const session = makeStore();
  const w = new JSDOM(html, { runScripts: 'outside-only', url: 'chrome-extension://abc/bench.html' }).window;
  const calls = { open: [], tabs: [] };
  w.chrome = {
    storage: { local, session, onChanged: { addListener() {} } },
    windows: { getCurrent: async () => ({ id: 3 }) },
    sidePanel: { open: async o => { calls.open.push(o); } },
    tabs: { create: async o => { calls.tabs.push(o); return { id: 42 }; } },
    runtime: { getURL: p => p, getManifest: () => ({ version: '0.9.6' }) }
  };
  loadScripts(w, ['bench.js'], ['render']);
  await sleep(100);
  return { w, doc: w.document, local, session, calls };
}

(async () => {
  const run = { id: 'r1', taskId: 'amazon-compare', version: '0.9.6', startedAt: Date.now(), mode: 'agent', model: 'claude-sonnet-5-5', params: {}, traceId: 't1', outcome: 'done', steps: 9, ms: 75000, cost: 0.21, costKnown: true, interventions: 0,
    summary: '| Name | Price |\n<img src=x onerror="window.pwned=1"> <b>bold</b>', checks: [{ ok: true, note: '3 prices' }, { ok: false, note: '1 ratings' }] };
  const p = await page({ benchRuns: [run], usage: { [new Date().toLocaleDateString('en-CA')]: { 'claude-sonnet-5-5': { calls: 1, input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 } } } });
  const { doc } = p;
  check('Lists the ten tasks, each with what counts as success and a cost estimate', doc.querySelectorAll('#tasks > li.task').length === 10 && /Success:/.test(doc.querySelector('#task-turkish-multicity').textContent) && /about \$[\d.]+–\$[\d.]+/.test(doc.querySelector('#task-turkish-multicity').textContent));
  check('Shows this month\'s spend and the per-run limit', /\$2\.00/.test(doc.querySelector('#monthSpend').textContent) && doc.querySelector('#maxCost').value === '0.6');
  check('Dates default to upcoming days', /^\d{4}-\d{2}-\d{2}$/.test(doc.querySelector('#task-turkish-multicity input[data-key="d1"]').value) && doc.querySelector('#task-turkish-multicity input[data-key="d1"]').type === 'date');
  const r = doc.querySelector('[data-run="r1"]');
  check('A run shows its numbers and checks', /9 steps · 1m 15s · \$0\.21 · 0 interventions/.test(r.textContent) && r.querySelectorAll('.checks .ok').length === 1 && r.querySelectorAll('.checks .bad').length === 1 && r.querySelector('a[href="runs.html#t1"]'), r.textContent);
  check('The run\'s answer is shown as text, never as HTML', !doc.querySelector('[data-run="r1"] img') && !doc.querySelector('[data-run="r1"] b') && !p.w.pwned && /<img src=x/.test(r.querySelector('pre').textContent));

  // grading
  r.querySelector('.note').value = 'ratings missing for one';
  r.querySelector('.grade-pass').click();
  await sleep(50);
  const graded = (await p.local.get('benchRuns')).benchRuns[0];
  check('Grading saves your verdict and note', graded.verdict === 'pass' && graded.note === 'ratings missing for one');
  await p.w.render();
  check('The score for this version counts it', /v0\.9\.6/.test(doc.querySelector('#scores tbody').textContent) && /1 of 1/.test(doc.querySelector('#scores tbody').textContent) && doc.querySelector('#noScores').hidden);

  // settings and Run
  const moodle = doc.querySelector('#task-moodle-due');
  moodle.querySelector('.run').click();
  await sleep(30);
  check('Run with a required setting missing says what to fill in, opens nothing', /Fill in: Your Moodle dashboard/.test(moodle.querySelector('.status').textContent) && !p.calls.tabs.length);
  const urlInput = moodle.querySelector('input[data-key="url"]');
  urlInput.value = 'https://moodle.example.edu/my/';
  urlInput.dispatchEvent(new p.w.Event('change'));
  await sleep(30);
  check('Task settings are saved', (await p.local.get('benchParams')).benchParams['moodle-due'].url === 'https://moodle.example.edu/my/');
  moodle.querySelector('.run').click();
  await sleep(50);
  const pending = (await p.session.get('benchPending')).benchPending;
  check('Run opens the side panel, opens the task in a new tab, and hands it over', p.calls.open[0]?.windowId === 3 && p.calls.tabs[0]?.url === 'https://moodle.example.edu/my/' && p.calls.tabs[0].active === true && pending?.taskId === 'moodle-due' && pending.tabId === 42 && pending.mode === 'agent' && pending.maxCost === 0.6 && /List every assignment/.test(pending.goal), JSON.stringify({ calls: p.calls, pending }));

  // OpenAI: no price, so no limit, so no Run
  const o = await page({ provider: 'openai', anthropicKey: '', openaiKey: 'k', openaiSmart: 'gpt-6-astra' });
  check('With a model Sidekick can\'t price, Run is off and it says why', [...o.doc.querySelectorAll('.run')].every(b => b.disabled) && !o.doc.querySelector('#priceWarning').hidden && /no price/.test(o.doc.querySelector('#priceWarning').textContent));

  console.log(results.join('\n'));
  const passedN = results.filter(r => r.startsWith('PASS')).length;
  console.log(`\n${passedN}/${results.length} passed`);
  process.exit(passedN === results.length ? 0 : 1);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
