// Storage writes don't lose each other (Phase F leftover): every read-modify-write runs under a
// lock per key (core/storage/update), a Web Lock shared by all Sidekick pages. Two jsdom windows
// share one slow fake storage and one fake lock manager, like the side panel and the profile page.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, makeStore, loadScripts, sleep } = H;
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 1200).replace(/\n/g, '\n        ') : ''}`);

// Reads and writes take a few random milliseconds, so two saves at once really interleave.
function slowStore(init) {
  const s = makeStore(init);
  const jitter = () => sleep(Math.random() * 6);
  return { ...s, get: async k => { await jitter(); const v = await s.get(k); await jitter(); return v; }, set: async o => { await jitter(); await s.set(o); }, remove: async k => { await jitter(); await s.remove(k); } };
}
// navigator.locks as Chrome has it: one queue per name, shared by every page of the extension.
function lockManager(log) {
  const chains = new Map();
  return {
    request(name, opts, fn) {
      if (typeof opts === 'function') fn = opts;
      log.push(name);
      const prev = chains.get(name) || Promise.resolve();
      let release; const held = new Promise(r => (release = r));
      chains.set(name, prev.then(() => held));
      return prev.then(async () => { try { return await fn({ name }); } finally { release(); } });
    }
  };
}
const EXPOSE = ['addMemory', 'deleteMemory', 'getMemories', 'logApplication', 'deleteApplication', 'getApplications', 'addSkill', 'patchSkill', 'markSkillUsed', 'getSkills',
  'addSiteNotes', 'deleteSiteNote', 'getSiteNotes', 'changeAdapters', 'getAdapters', 'recordUsage', 'saveBenchRun', 'gradeBenchRun', 'listBenchRuns', 'addDocument', 'getDocIndex', 'withStorageLock', 'updateLocal'];
function page(local, locks) {
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/sidepanel.html' }).window;
  if (locks) Object.defineProperty(w.navigator, 'locks', { value: locks, configurable: true });
  w.chrome = { storage: { local, session: makeStore(), onChanged: { addListener() {} } }, runtime: { getManifest: () => ({ version: '0.9.6' }) } };
  w.console.warn = (...a) => (w.__warned = (w.__warned || []).concat(a.join(' ')));
  loadScripts(w, ['memory.js'], EXPOSE);
  return w;
}

(async () => {
  const log = [];
  const locks = lockManager(log);
  const pre = [0, 1, 2, 3, 4].map(i => ({ id: `old${i}`, text: `Old memory ${i} about subject${i} lemon${i}`, created: 1, updated: 1, source: 'chat', kind: 'fact' }));
  const local = slowStore({ memories: pre, applications: [{ id: 'a0', date: '2026-10-01', company: 'Acme', role: 'Intern', status: 'submitted' }],
    adapters: [{ id: 's1', site: 'greenhouse.io', title: 'Apply', steps: [], created: 1, updated: 1, runs: 1, replays: 0, replayOk: 0 }],
    benchRuns: [{ id: 'r0', taskId: 'amazon-compare', version: '0.9.6', startedAt: 1, mode: 'agent', model: 'm', params: {}, outcome: 'done', steps: 1, ms: 1, cost: 0, costKnown: true, interventions: 0, summary: '', checks: [] }] });
  const panel = page(local, locks), profile = page(local, locks);

  // Memories: the panel learns ten facts while the profile page adds ten and deletes the old five.
  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => panel.addMemory(`Panel fact ${i} about topic${i} kiwi${i}`, 'chat')),
    ...Array.from({ length: 10 }, (_, i) => profile.addMemory(`Profile fact ${i} about thing${i} plum${i}`, 'manual')),
    ...pre.map(m => profile.deleteMemory(m.id))
  ]);
  const mems = await panel.getMemories();
  check('Memories: 20 added from two pages at once, 5 deleted at the same time; none lost, none back', mems.length === 20 && !mems.some(m => m.id.startsWith('old')) && new Set(mems.map(m => m.text)).size === 20, mems.map(m => m.text).join(' | '));
  check('The writes went through the shared lock (Web Locks, one name per key)', log.includes('sidekick-storage:memories') && log.filter(n => n === 'sidekick-storage:memories').length === 25, log.slice(0, 10).join(', '));

  // Applications: the agent logs five while the profile page removes the one already there.
  await Promise.all([...Array.from({ length: 5 }, (_, i) => panel.logApplication({ company: `Co${i}`, role: 'SWE intern' })), profile.deleteApplication('a0')]);
  const apps = await panel.getApplications();
  check('Applications: 5 logged while one is removed; all 5 kept, the removed one stays gone', apps.length === 5 && !apps.some(a => a.id === 'a0') && apps.every(a => a.status === 'submitted' && a.date), JSON.stringify(apps.map(a => a.company)));

  // Skills: two pages add different skills and count uses at once.
  const s0 = (await panel.addSkill({ name: 'Rounding', when: 'math answers', body: 'Round to 4 decimals.' })).skill;
  await Promise.all([
    ...Array.from({ length: 4 }, (_, i) => panel.addSkill({ name: `Skill ${i}`, when: 'x', body: `Step ${i}.` })),
    ...Array.from({ length: 4 }, (_, i) => profile.addSkill({ name: `Other ${i}`, when: 'y', body: `Do ${i}.` })),
    ...Array.from({ length: 6 }, () => profile.markSkillUsed(s0.id))
  ]);
  const skills = await panel.getSkills();
  check('Skills: 8 added from two pages and 6 uses counted at once; nothing lost', skills.length === 9 && skills.find(s => s.id === s0.id)?.uses === 6, JSON.stringify(skills.map(s => [s.name, s.uses])));
  let err = null;
  try { await panel.patchSkill('No such skill', 'a', 'b'); } catch (e) { err = e; }
  check('An error inside a locked change is reported (and the next change still runs)', /No skill named/.test(err?.message) && (await panel.patchSkill('Rounding', '4', '5')).body === 'Round to 5 decimals.');

  // Site notes: a run learns notes while an import adds some and the profile page deletes one.
  await panel.addSiteNotes('greenhouse.io', ['Old note to delete']);
  await Promise.all([
    panel.addSiteNotes('greenhouse.io', ['Location is a custom dropdown', 'Upload the resume first']),
    profile.addSiteNotes('greenhouse.io', ['location is a  custom dropdown', 'The submit button is at the bottom']),
    profile.deleteSiteNote('greenhouse.io', 'Old note to delete'),
    profile.addSiteNotes('myopenmath.com', ['Answers go in MathQuill boxes'])
  ]);
  const notes = await panel.getSiteNotes();
  check('Site notes: added from two pages and one deleted at once; duplicates (case, spacing) kept once', notes['greenhouse.io']?.length === 3 && !notes['greenhouse.io'].some(n => /Old note/.test(n.text)) && notes['myopenmath.com']?.length === 1, JSON.stringify(notes));

  // Shortcuts: ten replays counted at once.
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? panel : profile).changeAdapters(list => { const s = list.find(x => x.id === 's1'); if (!s) return undefined; s.replays++; if (i < 7) s.replayOk++; return list; })));
  const ad = (await panel.getAdapters())[0];
  check('Shortcuts: 10 replays counted from two pages at once', ad.replays === 10 && ad.replayOk === 7, JSON.stringify(ad));

  // Usage: the panel and the quality-checks page both call models.
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? panel : profile).recordUsage('claude-haiku-5-5', { input: 10, output: 1 })));
  const day = Object.values(local.data().usage)[0]['claude-haiku-5-5'];
  check('Usage: 20 calls recorded from two pages at once', day.calls === 20 && day.input === 200 && day.output === 20, JSON.stringify(day));

  // Benchmark: the panel saves runs while the Benchmark page grades another.
  const run = i => ({ id: `r${i}`, taskId: 'amazon-compare', version: '0.9.6', startedAt: i, mode: 'agent', model: 'm', params: {}, outcome: 'done', steps: 1, ms: 1, cost: 0, costKnown: true, interventions: 0, summary: '', checks: [] });
  await Promise.all([panel.saveBenchRun(run(1)), profile.gradeBenchRun('r0', 'pass', 'ok'), panel.saveBenchRun(run(2)), profile.gradeBenchRun('r0', 'pass', 'still ok')]);
  const runs = await panel.listBenchRuns();
  check('Benchmark: runs saved in the panel while the Benchmark page grades; nothing lost', runs.length === 3 && runs.find(r => r.id === 'r0')?.verdict === 'pass' && runs.find(r => r.id === 'r0')?.note === 'still ok', JSON.stringify(runs.map(r => [r.id, r.verdict, r.note])));

  // Documents: index and text written together.
  await Promise.all(Array.from({ length: 4 }, (_, i) => (i % 2 ? panel : profile).addDocument(`doc${i}.txt`, `Document ${i} text. `.repeat(20))));
  const idx = await panel.getDocIndex();
  check('Documents: 4 added from two pages at once; index and text both kept', idx.length === 4 && idx.every(d => local.data()['doc:' + d.id]?.chunks?.length));

  // Without Web Locks (an older browser, the tests' plain pages) a queue per name orders writes in the page.
  const local2 = slowStore({ memories: [] });
  const solo = page(local2, null);
  await Promise.all(Array.from({ length: 12 }, (_, i) => solo.addMemory(`Solo fact ${i} about item${i} fig${i}`)));
  check('Without Web Locks, writes in one page are still queued (12 of 12 kept)', (await solo.getMemories()).length === 12);

  // A lock that can't be had in time (another page stuck): the write still happens, with a warning.
  const local3 = slowStore({ memories: [] });
  const stuck = page(local3, { request: () => Promise.reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })) });
  await stuck.addMemory('Saved even though the lock timed out');
  check('A lock wait that times out still saves (never hangs, never drops) and warns', (await stuck.getMemories()).length === 1 && /storage lock/.test((stuck.__warned || []).join(' ')));

  // A change that fails inside the lock runs once (not again without the lock).
  let runsOfFn = 0;
  const failing = page(slowStore({}), lockManager([]));
  try { await failing.withStorageLock('skills', async () => { runsOfFn++; throw new Error('boom'); }); } catch { /* expected */ }
  check('A change that throws inside the lock runs once and its error comes back', runsOfFn === 1);

  console.log(results.join('\n'));
  const passed = results.filter(r => r.startsWith('PASS')).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.log('CRASH', e.stack); process.exit(1); });
