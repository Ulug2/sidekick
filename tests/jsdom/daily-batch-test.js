// v1 Phase 4: the 8 AM batch. The service worker's catch-up builds the day's batch once (15-20
// jobs, one per company), notifies, and sets tomorrow's alarm; approving spreads the applications
// over the day at random times at least 15 minutes apart, each with an alarm and a log line.
// Storage and alarms are faked; no model is called.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, makeStore, loadScripts } = H;
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 1200).replace(/\n/g, '\n        ') : ''}`);

const DAY = 864e5;
const job = (i, company, score) => ({ id: `greenhouse:b${i}:${i}`, ats: 'greenhouse', board: `b${i}`, company, title: 'Software Engineer, New Grad', location: 'New York, NY', url: `https://x/${i}`, applyUrl: `https://x/${i}`, ok: true, regions: ['usa'], countries: ['US'], sponsor: 'likely', why: [], score, status: 'found', firstSeen: 1, lastSeen: 1 });

(async () => {
  // 25 eligible jobs at 22 companies (three companies have two), one company applied to last week.
  const jobs = Array.from({ length: 22 }, (_, i) => job(i, `Company ${i}`, 50 + i));
  jobs.push(job(30, 'Company 3', 99), job(31, 'Company 4', 98), job(32, 'Company 5', 97));
  jobs.push({ ...job(40, 'Company 21', 10), status: 'applied', appliedAt: Date.parse('2026-11-05T15:00:00Z') });
  const local = makeStore({ jobs });
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/jobs.html' }).window;
  w.chrome = { storage: { local, session: makeStore(), onChanged: { addListener() {} } }, runtime: { getURL: p => p } };
  loadScripts(w, ['jobs.js'], ['ensureDailyBatch', 'approveSpread', 'nextAt', 'cancelApplication']);
  let now = Date.parse('2026-11-11T12:30:00Z'); // 7:30 AM in New York
  const alarms = new Map(), notes = [];
  const host = { now: () => now, alarms: { create: async (n, at) => { alarms.set(n, at); }, clear: async n => { alarms.delete(n); }, list: async () => [...alarms].map(([name, at]) => ({ name, at })) }, notify: async (t, m) => { notes.push(`${t}: ${m}`); } };

  // ---- before 8 AM: nothing built, the alarm is set for 8:00 ET today ----
  check('Before 8 AM: the alarm is set for 8:00 New York time, nothing is built', await w.ensureDailyBatch(host) === 'scheduled' && alarms.get('batch-8am') === Date.parse('2026-11-11T13:00:00Z') && !local.data().jobs.some(j => j.status === 'queued'), JSON.stringify([...alarms]));

  // ---- the alarm fires at 8:00 ----
  now = Date.parse('2026-11-11T13:00:05Z');
  const r = await w.ensureDailyBatch(host);
  const queued = local.data().jobs.filter(j => j.status === 'queued');
  const companies = new Set(queued.map(j => j.company));
  check('8 AM: the batch is built: 18 jobs, one per company, best first, never a company applied to this month', r === 'built' && queued.length === 18 && companies.size === 18 && !companies.has('Company 21') && queued.some(j => j.id === 'greenhouse:b30:30') && !queued.some(j => j.id === 'greenhouse:b3:3'), JSON.stringify(queued.map(j => j.company)));
  check('8 AM: he is notified (nothing is sent before he approves) and tomorrow\'s alarm is set', notes.length === 1 && /18 jobs, one per company/.test(notes[0]) && /nothing is sent before that/.test(notes[0]) && alarms.get('batch-8am') === Date.parse('2026-11-12T13:00:00Z') && local.data().orchestrator.lastBatchAt === now, JSON.stringify({ notes, next: new Date(alarms.get('batch-8am')).toISOString() }));
  now += 60000;
  check('The service worker starting again the same day builds nothing more', await w.ensureDailyBatch(host) === 'scheduled' && local.data().jobs.filter(j => j.status === 'queued').length === 18 && notes.length === 1);

  // ---- approve: random times over 20 hours, at least 15 minutes apart, each with an alarm and a log line ----
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const plan = await w.approveSpread(host, rnd);
  const times = plan.map(p => p.at);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const log = local.data().actionLog || [];
  check('Approve: every queued job gets a random time within 20 hours, at least 15 minutes apart, and its own alarm', plan.length === 18 && gaps.every(g => g >= 15 * 60000) && new Set(gaps).size > 10 && times[17] <= now + 20 * 3600e3 && plan.every(p => alarms.get(`apply:${p.id}`) === p.at && local.data().jobs.find(j => j.id === p.id).scheduledAt === p.at), JSON.stringify(gaps.map(g => Math.round(g / 60000))));
  check('Approve: each time is logged (Activity) and persisted for a restart', log.filter(e => e.kind === 'schedule').length === 18 && /set for .* ET/.test(log[0].what) && local.data().scheduled.filter(s => s.name.startsWith('apply:')).length === 18, JSON.stringify(log.slice(0, 2)));
  check('Approving again adds nothing', (await w.approveSpread(host, rnd)).length === 0);

  // ---- review 2026-11-11: an alarm that fired while the panel was closed, then the job was removed ----
  const gone = plan[0].id;
  await local.set({ firedAlarms: [{ name: `apply:${gone}`, at: plan[0].at }, { name: 'remind:x', at: 1 }] });
  await w.cancelApplication(host, gone);
  check('Removing a job cancels its alarm, its time, and an alarm that already fired (it can never run unapproved later)', !alarms.has(`apply:${gone}`) && !local.data().jobs.find(j => j.id === gone).scheduledAt && local.data().firedAlarms.length === 1 && local.data().firedAlarms[0].name === 'remind:x', JSON.stringify(local.data().firedAlarms));

  // ---- Chrome was closed at 8: the first wake builds it ----
  now = Date.parse('2026-11-12T16:00:00Z'); // 11 AM the next day, the alarm missed
  for (const j of local.data().jobs) if (j.status === 'queued') j.status = 'applied', j.appliedAt = now - 3600e3;
  await local.set({ jobs: local.data().jobs });
  check('Chrome closed at 8 AM: the first wake after builds the missed batch', await w.ensureDailyBatch(host) === 'built' && notes.length === 2, notes.at(-1));

  console.log(results.join('\n'));
  const passed = results.filter(x => x.startsWith('PASS')).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.log(results.join('\n')); console.log('CRASH', e.stack); process.exit(1); });
