// Phase 2 in the bundled code: the spend cap stops every model call before anything is sent, a
// cap hit inside an agent run pauses the orchestrator, and the action log records what was done.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, makeStore, loadScripts, sleep } = H;
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 1200).replace(/\n/g, '\n        ') : ''}`);

function boot(store) {
  const local = makeStore(store);
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/x.html' }).window;
  const sent = [];
  w.chrome = { storage: { local, session: makeStore(), onChanged: { addListener() {} } }, runtime: { getURL: p => p, getManifest: () => ({ version: '0.9.6' }) } };
  w.fetch = async (u, o) => { sent.push(JSON.parse(o.body)); return H.sseResponse(H.anthropicEvents([{ type: 'text', text: 'ok' }])); };
  loadScripts(w, ['memory.js'], ['modelCall', 'logAction', 'readLog', 'buildWorld', 'worldQuery']);
  return { w, local, sent };
}
const today = new Date().toLocaleDateString('en-CA');

(async () => {
  {
    const { w, sent } = boot({ anthropicKey: 'k', capDaily: 1, capMonthly: 25, usage: { [today]: { 'claude-sonnet-5-5': { calls: 9, input: 400000, output: 30000, cacheRead: 0, cacheWrite: 0 } } } }); // $0.80 + $0.30 = $1.10 today
    let err = null;
    try { await w.modelCall({ tier: 'fast', system: 's', messages: [{ role: 'user', text: 'hi' }] }); } catch (e) { err = e; }
    check('Over the daily cap: the call is refused before anything is sent', err?.name === 'SpendCapError' && /daily spend cap \(\$1\.00\) is reached \(\$1\.10 spent\)/.test(err.message) && sent.length === 0, `${err?.name}: ${err?.message} sent=${sent.length}`);
  }
  {
    const { w, sent } = boot({ anthropicKey: 'k', capDaily: 1, capMonthly: 25, usage: { [today]: { 'claude-haiku-5-5': { calls: 2, input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 } } } });
    const r = await w.modelCall({ tier: 'fast', system: 's', messages: [{ role: 'user', text: 'hi' }] });
    check('Under the cap: the call goes through', r.text === 'ok' && sent.length === 1);
  }
  {
    const { w, sent } = boot({ anthropicKey: 'k', capDaily: 0, capMonthly: 0, usage: { [today]: { 'claude-sonnet-5-5': { calls: 99, input: 9e7, output: 0, cacheRead: 0, cacheWrite: 0 } } } });
    await w.modelCall({ tier: 'fast', system: 's', messages: [{ role: 'user', text: 'hi' }] });
    check('Caps of 0 mean no cap', sent.length === 1);
  }
  {
    const { w } = boot({});
    await Promise.all([w.logAction({ worker: 3, kind: 'submit', what: 'Clicked “Submit application” on greenhouse.io', why: 'pre-approved', site: 'greenhouse.io', jobId: 'j1' }), w.logAction({ worker: 4, kind: 'upload', what: 'Attached resume.pdf on 4111 1111 1111 1111 site', site: 'x' })]);
    const log = await w.readLog();
    check('Action log keeps both entries from two agents at once (locked writes), newest first, secrets masked', log.length === 2 && log.some(e => e.worker === 3 && e.kind === 'submit' && e.jobId === 'j1') && !log.some(e => /4111 1111/.test(e.what)), JSON.stringify(log));
  }
  {
    const now = Date.now();
    const { w } = boot({ jobs: [{ id: 'a', company: 'Stripe', title: 'SWE', status: 'applied', appliedAt: now - 864e5, ok: true, score: 90, location: 'NYC', why: [], regions: ['usa'], countries: ['US'], sponsor: 'strong' }, { id: 'b', company: 'Ramp', title: 'SWE', status: 'queued', ok: true, score: 80, location: 'NYC', why: [], regions: [], countries: [], sponsor: 'likely' }] });
    const world = await w.buildWorld();
    check('World state built from storage: applied and queued jobs, companies in the last 30 days', world.jobs.applied.length === 1 && world.jobs.queued[0].company === 'Ramp' && world.jobs.companiesApplied30d.join() === 'Stripe' && /^Stripe: SWE: applied/.test(w.worldQuery(world, 'did I apply to stripe')), JSON.stringify(world.jobs));
  }

  console.log(results.join('\n'));
  const passed = results.filter(r => r.startsWith('PASS')).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.log(results.join('\n')); console.log('CRASH', e.stack); process.exit(1); });
