// v0.8 (Phase 2): learned site shortcuts, WebMCP site tools, change-only snapshots, batching.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { srcPath } = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, sleep, makeStore, sseResponse, anthropicEvents, loadScripts, fs, DIR } = H;
const { prep } = require(require('path').join(__dirname, 'engine-test.js'));
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 1200).replace(/\n/g, '\n        ') : ''}`);
const AGENT_SCRIPTS = ['ai.js', 'guard.js', 'profile-core.js', 'memory.js', 'skills.js', 'docs.js', 'screen.js', 'page-agent.js', 'cdp.js', 'adapters.js', 'agent.js'];
const CAPTURE = fs.readFileSync(srcPath('webmcp-capture.js'), 'utf8');

const JOB = fs.readFileSync(require('path').join(__dirname, '..', 'fixtures', 'job.html'), 'utf8');

const PROFILE = {
  fullName: 'Ulugbek Rivera', email: 'ulugbek@example.edu', city: 'New York', state: 'NY',
  workAuthorized: 'Yes', needsSponsorship: 'No',
  resume: { name: 'resume.pdf', type: 'application/pdf', size: 10, dataUrl: 'data:application/pdf;base64,JVBERi0=' }
};
const WHY = 'I want to build apps that real users rely on, and Acme ships fast.';

function makePage(html, url, setup) {
  const w = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url }).window;
  prep(w);
  if (setup) setup(w);
  return w;
}

// One agent run against fake Chrome + fake Claude. plan[i] returns one call [name, input] or
// several [[name, input], ...] for the i-th agent turn.
async function runAgentOn(pages, startUrl, { goal = 'Apply to this job', plan, store, approvals = [], settings = {} }) {
  let url = startUrl;
  const page = () => pages[url];
  const local = store || makeStore({ anthropicKey: 'k', profile: PROFILE, ...settings });
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/sidepanel.html' }).window;
  const reqs = [], agentReqs = [];
  w.chrome = {
    storage: { local, session: makeStore() },
    tabs: {
      query: async () => [{ id: 5, windowId: 1, active: true, url, title: page().document.title }],
      get: async id => ({ id, windowId: 1, active: true, status: 'complete', url, title: page().document.title }),
      update: async (id, o) => { if (o.url) url = o.url; return {}; },
      onCreated: { addListener() {}, removeListener() {} },
      goBack: async () => {}
    },
    scripting: {
      executeScript: async ({ func, args }) => [{ frameId: 0, result: JSON.parse(JSON.stringify((await page().eval(`(${func.toString()})`)(...(args || [])) ) ?? null)) }]
    },
    debugger: undefined,
    runtime: { getURL: p => p }
  };
  w.fetch = async (u, o) => {
    const body = JSON.parse(o.body); { const __ck = H.checkerReply(body); if (__ck) return __ck; } reqs.push(body);
    if (/reusable operating notes/.test(body.system || '')) return sseResponse(anthropicEvents([{ type: 'text', text: '{"notes":["The Location field is a native dropdown; pick the full city name."]}' }]));
    agentReqs.push(body);
    const step = body.messages.filter(m => m.role === 'assistant').length;
    const all = JSON.stringify(body.messages);
    const id = re => { const m = all.match(new RegExp(String.raw`\[(\d+)\] [a-z:]+ \\"` + re)); return m && m[1]; };
    const lastResult = (() => { const last = body.messages.at(-1); return JSON.stringify(last.content); })();
    let calls = plan[step]({ id, all, lastResult });
    if (!Array.isArray(calls[0])) calls = [calls];
    return sseResponse(anthropicEvents(calls.map(([name, input], k) => ({ type: 'tool_use', id: `tu${step}_${k}`, name, input })), { stop: 'tool_use' }));
  };
  loadScripts(w, AGENT_SCRIPTS, ['runAgent', 'getAdapters', 'siteOf']);
  const steps = [], asked = [], notes = [];
  const ui = {
    signal: new AbortController().signal,
    step: t => { const s = { t }; steps.push(s); return { waiting() {}, done: (ok, d) => { s.ok = ok; s.d = d; } }; },
    note: t => notes.push(t),
    approve: async a => { asked.push(a); return approvals.length ? approvals.shift() : true; },
    ask: async () => 'ok'
  };
  const r = await w.runAgent(goal, ui);
  return { r, steps, asked, reqs, agentReqs, local, w, notes };
}
const toolResults = req => (req.messages.at(-1).content || []).filter(c => c.type === 'tool_result').map(c => c.content.map(x => x.text || '').join(''));

(async () => {
  // ---------- 1. unit: matching and compiling ----------
  {
    const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/x.html' }).window;
    w.chrome = { storage: { local: makeStore(), session: makeStore() }, runtime: { getURL: p => p } };
    loadScripts(w, ['guard.js', 'adapters.js'], ['siteOf', 'findTarget', 'compileFlow', 'profileKeyFor', 'profileValues']);
    check('siteOf: subdomains are one site, country domains kept', w.siteOf('https://boards.greenhouse.io/acme/jobs/1') === 'greenhouse.io' && w.siteOf('https://job-boards.greenhouse.io/x') === 'greenhouse.io' && w.siteOf('https://jobs.example.co.uk/a') === 'example.co.uk' && w.siteOf('https://www.myopenmath.com/assess2/') === 'myopenmath.com');
    check('siteOf: shared hosting subdomains belong to different people (alice.github.io ≠ evil.github.io)', w.siteOf('https://alice.github.io/x') === 'alice.github.io' && w.siteOf('https://evil.github.io') === 'evil.github.io' && w.siteOf('https://app.vercel.app/') === 'app.vercel.app' && w.siteOf('https://b.s3.amazonaws.com/k') === 'b.s3.amazonaws.com' && w.siteOf('https://x.up.railway.app') === 'x.up.railway.app' && w.siteOf('https://github.io') === 'github.io');
    check('siteOf: full Public Suffix List: hosts it knows are shared stay apart, region hosts aren\'t merged', w.siteOf('https://alice.pythonanywhere.com/') === 'alice.pythonanywhere.com' && w.siteOf('https://bob.pythonanywhere.com/') === 'bob.pythonanywhere.com' && w.siteOf('https://a.eu-west-1.elasticbeanstalk.com') === 'a.eu-west-1.elasticbeanstalk.com' && w.siteOf('https://b.eu-west-1.elasticbeanstalk.com') !== w.siteOf('https://a.eu-west-1.elasticbeanstalk.com') && w.siteOf('https://city.kyoto.jp') === 'city.kyoto.jp' && w.siteOf('https://x.example.com.au') === 'example.com.au' && w.siteOf('https://alice.medium.com') === 'alice.medium.com' && w.siteOf('https://localhost:3000/') === 'localhost' && w.siteOf('http://127.0.0.1/') === '127.0.0.1');
    const els = {
      '1': { role: 'radio', label: 'Yes', line: '[1] radio "Yes" question: "Are you legally authorized to work in the US?", unchecked' },
      '2': { role: 'radio', label: 'Yes', line: '[2] radio "Yes" question: "Will you now or in the future require visa sponsorship?", unchecked' },
      '3': { role: 'textbox', label: 'First name *', line: '[3] textbox "First name *" empty' },
      '4': { role: 'textbox:email', label: 'Email', line: '[4] textbox:email "Email" empty' }
    };
    check('findTarget: the right "Yes" by its question', w.findTarget(els, { role: 'radio', label: 'Yes', question: 'Will you now or in the future require visa sponsorship?' }) === '2' && w.findTarget(els, { role: 'radio', label: 'Yes', question: 'Are you legally authorized to work in the US?' }) === '1');
    check('findTarget: labels match loosely (case, asterisks), roles by family', w.findTarget(els, { role: 'textbox', label: 'First Name' }) === '3' && w.findTarget(els, { role: 'textbox', label: 'Email *' }) === '4' && w.findTarget(els, { role: 'button', label: 'Email' }) === null);
    const vals = w.profileValues({ ...PROFILE, willingToRelocate: 'Yes' });
    check('profileKeyFor: same value told apart by the question', w.profileKeyFor('Yes', vals, 'Are you legally authorized to work?') === 'workAuthorized' && w.profileKeyFor('Yes', vals, 'Are you willing to relocate?') === 'willingToRelocate' && w.profileKeyFor('Yes', vals, 'Do you like cats?') === null && w.profileKeyFor('Ulugbek', vals, 'First name') === 'firstName');
    const site = 'greenhouse.io';
    const flow = w.compileFlow([
      { tool: 'click', role: 'button', label: 'Apply', site, description: 'Open the form' },
      { tool: 'type', role: 'textbox', label: 'First Name', value: 'Ulugbek', site },
      { tool: 'type', role: 'textbox', label: 'First Name', value: 'Ulugbek', site },
      { tool: 'type', role: 'textarea', label: 'Why Acme?', value: WHY, site },
      { tool: 'set_checked', role: 'checkbox', label: 'I agree to the terms', value: true, site },
      { tool: 'click', role: 'button', label: 'Submit application', final: true, description: 'Submit. Authorized: Yes', site }
    ], PROFILE, 'Apply to Acme');
    const stepsJson = JSON.stringify(flow.steps);
    check('compileFlow: profile values become field names, retries collapse', flow.steps.length === 5 && flow.steps[1].valueKey === 'firstName' && !('value' in flow.steps[1]));
    check('compileFlow: written answers, consent boxes and submit are never automatic', flow.steps[2].needsModel && flow.steps[3].needsModel && flow.steps[4].final);
    check('compileFlow: nothing typed is stored (no name, no answer, no final description)', !/Ulugbek|real users|Authorized: Yes/.test(stepsJson), stepsJson);
  }

  // ---------- 2. first run: learns a shortcut; batching, diffs, sections, hints ----------
  const store = makeStore({ anthropicKey: 'k', profile: PROFILE });
  let firstRunCalls = 0;
  {
    const pages = { 'https://boards.greenhouse.io/acme/jobs/42': makePage(JOB, 'https://boards.greenhouse.io/acme/jobs/42') };
    const P = pages['https://boards.greenhouse.io/acme/jobs/42'];
    const { r, steps, asked, agentReqs, notes } = await runAgentOn(pages, 'https://boards.greenhouse.io/acme/jobs/42', {
      store,
      plan: [
        ({ id }) => ['click', { id: id('Apply for this job'), description: 'Open the application form', final_action: false }],
        ({ id }) => ['fill_fields', { fields: [
          { id: id('First Name'), value: 'Ulugbek' }, { id: id('Last Name'), value: 'Rivera' }, { id: id('Email'), value: 'ulugbek@example.edu' },
          { id: id('Create a password'), value: 'hunter2' }, { id: id('Location'), value: 'New York, NY' }, { id: id('Resume/CV'), value: 'resume' }
        ] }],
        ({ all }) => {
          const auth = all.match(/\[(\d+)\] radio \\"Yes\\" question: \\"Are you legally/)[1];
          const spon = all.match(/\[(\d+)\] radio \\"No\\" question: \\"Will you now/)[1];
          return [['set_checked', { id: auth, checked: true }], ['set_checked', { id: spon, checked: true }]];
        },
        ({ id }) => [['type', { id: id('Why do you want'), text: WHY }], ['set_checked', { id: id('I agree'), checked: true }]],
        ({ id }) => ['click', { id: id('Submit application'), description: 'Submit the application. Authorized: Yes', final_action: true }],
        () => ['done', { summary: 'Applied.' }]
      ]
    });
    firstRunCalls = agentReqs.length;
    const d = P.document;
    check('Run 1: form filled and submitted after approval', d.getElementById('fn').value === 'Ulugbek' && d.getElementById('em').value === 'ulugbek@example.edu' && d.getElementById('loc').value === 'New York, NY' && d.getElementById('authY').checked && d.getElementById('sponN').checked && d.getElementById('cv').files[0]?.name === 'resume.pdf' && d.getElementById('consent').checked && P.log.includes('submitted') && /Submit application/.test(asked.at(-1)?.title || ''), JSON.stringify(steps.slice(-6)));
    const fillRes = toolResults(agentReqs[2])[0];
    check('fill_fields: 5 fields in one call, the password refused and reported', /Filled 5 of 6 fields/.test(fillRes) && /Create a password.*never fills/.test(fillRes) && d.getElementById('pw').value === '', fillRes.slice(0, 500));
    check('After the first full snapshot, only changes are sent', /Same page as the last full snapshot/.test(fillRes) && !/Interactive elements:/.test(fillRes) && /~ \[\d+\] textbox "First Name \*" value: "Ulugbek"/.test(fillRes), fillRes.slice(0, 800));
    const applyRes = toolResults(agentReqs[1])[0];
    check('A big change (the form opening) gets a fresh full snapshot with sections and hints', /Interactive elements:/.test(applyRes) && /## Personal info\n\[\d+\] textbox "First Name \*" empty, required/.test(applyRes) && /hint: "We'll send updates here"/.test(applyRes), applyRes.slice(0, 900));
    const two = toolResults(agentReqs[3]);
    check('Two actions in one turn: only the last returns the page', two.length === 2 && /^Done\. \(The updated page comes after your last action/.test(two[0]) && /Same page as the last full snapshot/.test(two[1]));
    check('Agent may batch (parallel tool use on)', agentReqs[0].tool_choice?.disable_parallel_tool_use === false);
    const ads = store.data().adapters || [];
    const a = ads[0];
    const byLabel = l => a?.steps.find(s => s.label.startsWith(l));
    check('Shortcut learned for greenhouse.io', ads.length === 1 && a.site === 'greenhouse.io' && a.steps.length >= 10, JSON.stringify(ads).slice(0, 600));
    check('Shortcut: profile fields by name, radios by profile answer', byLabel('First Name')?.valueKey === 'firstName' && byLabel('Last Name')?.valueKey === 'lastName' && byLabel('Email')?.valueKey === 'email' && byLabel('Location')?.valueKey === 'location' && a.steps.find(s => s.role === 'radio' && /authorized/.test(s.question))?.labelKey === 'workAuthorized' && a.steps.find(s => s.role === 'radio' && /sponsorship/.test(s.question))?.labelKey === 'needsSponsorship', JSON.stringify(a?.steps));
    check('Shortcut: written answer and consent left to the agent, submit is final', byLabel('Why do you want')?.needsModel && byLabel('I agree')?.needsModel && byLabel('Submit application')?.final);
    check('Shortcut stores no typed values', !/Ulugbek|example\.edu|real users|hunter2|Authorized: Yes/.test(JSON.stringify(ads)));
    check('You see that a shortcut was saved', r.learned?.shortcut?.site === 'greenhouse.io' && notes.some(n => /Saved a shortcut/.test(n)) === false); // panel adds the note; runAgent returns it
    check('Site notes learned from the refused password step', (store.data().siteNotes?.['greenhouse.io'] || []).length === 1);
  }

  // ---------- 3. second run: the shortcut does the routine part instantly ----------
  {
    const pages = { 'https://job-boards.greenhouse.io/acme/jobs/77': makePage(JOB, 'https://job-boards.greenhouse.io/acme/jobs/77') };
    const P = pages['https://job-boards.greenhouse.io/acme/jobs/77'];
    let atShortcut = null;
    const { r, agentReqs, asked } = await runAgentOn(pages, 'https://job-boards.greenhouse.io/acme/jobs/77', {
      store,
      plan: [
        ({ all }) => ['use_shortcut', { shortcut_id: all.match(/\[(s_[a-z0-9]+)\]/)[1] }],
        ({ id, lastResult }) => { atShortcut = lastResult; return [['type', { id: id('Why do you want'), text: WHY }], ['set_checked', { id: id('I agree'), checked: true }]]; },
        ({ id }) => ['click', { id: id('Submit application'), description: 'Submit the application', final_action: true }],
        () => ['done', { summary: 'Applied again.' }]
      ]
    });
    const first = JSON.stringify(agentReqs[0].messages[0]);
    check('Run 2: snapshot lists the learned shortcut and site notes', /learned shortcuts for this site/.test(first) && /\[s_[a-z0-9]+\] Apply to this job/.test(first) && /Notes from earlier runs on this site/.test(first) && /native dropdown/.test(first), first.slice(0, 1500));
    const d = P.document;
    check('Shortcut filled the routine fields from the profile', /did \d+ of \d+ steps/.test(atShortcut) && d.getElementById('fn').value && d.getElementById('ln').value === 'Rivera' && d.getElementById('loc').value === 'New York, NY' && d.getElementById('cv').files[0]?.name === 'resume.pdf', atShortcut?.slice(0, 600));
    check('Shortcut chose radios from the profile answers (authorized: Yes, sponsorship: No)', d.getElementById('authY').checked && d.getElementById('sponN').checked && !d.getElementById('sponY').checked);
    check('Shortcut stopped at the written answer; consent not ticked by the replay', /Stopped: step \d+ needs your judgment: type into textarea/.test(atShortcut) && /a written answer/.test(atShortcut), atShortcut?.slice(0, 800));
    check('Run 2 finished with the submit approved', P.log.includes('submitted') && asked.length === 1 && r.summary === 'Applied again.');
    check(`Run 2 needed fewer model calls (${agentReqs.length} vs ${firstRunCalls})`, agentReqs.length < firstRunCalls);
    const ads = store.data().adapters;
    check('Same shortcut updated, not duplicated; replay recorded as a success', ads.length === 1 && ads[0].runs === 2 && ads[0].replays === 1 && ads[0].replayOk === 1, JSON.stringify(ads.map(a => [a.runs, a.replays, a.replayOk])));
  }

  // ---------- 4. replay safety: page changed, or profile missing a field ----------
  {
    const changed = JOB.replace('First Name *', 'Given name *');
    const pages = { 'https://boards.greenhouse.io/acme/jobs/9': makePage(changed, 'https://boards.greenhouse.io/acme/jobs/9') };
    let res = null;
    await runAgentOn(pages, 'https://boards.greenhouse.io/acme/jobs/9', {
      store,
      plan: [({ all }) => ['use_shortcut', { shortcut_id: all.match(/\[(s_[a-z0-9]+)\]/)[1] }], ({ lastResult }) => { res = lastResult; return ['done', { summary: 'ok' }]; }]
    });
    check('Page differs from last time: the replay stops and hands back, nothing guessed', /couldn't find type into textbox “First Name \*”/.test(res) && /Finish the task normally/.test(res), res?.slice(0, 600));
    const a = store.data().adapters[0];
    check('A failed replay counts against the shortcut', a.replays === 2 && a.replayOk === 1);
    const store2 = makeStore({ ...store.data(), profile: { ...PROFILE, email: '' } });
    const pages2 = { 'https://boards.greenhouse.io/acme/jobs/10': makePage(JOB, 'https://boards.greenhouse.io/acme/jobs/10') };
    let res2 = null;
    await runAgentOn(pages2, 'https://boards.greenhouse.io/acme/jobs/10', {
      store: store2, settings: {},
      plan: [({ all }) => ['use_shortcut', { shortcut_id: all.match(/\[(s_[a-z0-9]+)\]/)[1] }], ({ lastResult }) => { res2 = lastResult; return ['done', { summary: 'ok' }]; }]
    });
    check('Missing profile field: the replay stops and says which', /needs \\"email\\", which isn't in the profile/.test(res2) && pages2['https://boards.greenhouse.io/acme/jobs/10'].document.getElementById('em').value === '', res2?.slice(0, 500));
  }

  // ---------- 5. learning off ----------
  {
    const store3 = makeStore({ anthropicKey: 'k', profile: PROFILE, learnSites: false });
    const pages = { 'https://boards.greenhouse.io/x/jobs/1': makePage(JOB, 'https://boards.greenhouse.io/x/jobs/1') };
    await runAgentOn(pages, 'https://boards.greenhouse.io/x/jobs/1', {
      store: store3,
      plan: [
        ({ id }) => ['click', { id: id('Apply for this job'), description: 'Open', final_action: false }],
        ({ id }) => ['fill_fields', { fields: [{ id: id('First Name'), value: 'U' }, { id: id('Last Name'), value: 'K' }, { id: id('Email'), value: 'u@x.edu' }] }],
        () => ['done', { summary: 'ok' }]
      ]
    });
    check('Setting off: nothing learned', !(store3.data().adapters || []).length && !store3.data().siteNotes);
  }

  // ---------- 6. repeated buttons collapse; any id still works ----------
  {
    const cards = Array.from({ length: 6 }, (_, i) => `<div class="card"><a href="/jobs/${i}">Job ${i}</a><button onclick="log.push('save${i}')">Save</button></div>`).join('');
    const html = `<!doctype html><html><head><title>Jobs</title></head><body><main><h1>Jobs</h1>${cards}</main><script>window.log=[]</script></body></html>`;
    const pages = { 'https://jobs.example.com/list': makePage(html, 'https://jobs.example.com/list') };
    let first = '';
    await runAgentOn(pages, 'https://jobs.example.com/list', {
      plan: [
        ({ all }) => { first = all; const ids = all.match(/\[([\d,]+)\] button \\"Save\\" ×6/)[1].split(','); return ['click', { id: ids[2], description: 'Save job 2', final_action: false }]; },
        () => ['done', { summary: 'ok' }]
      ]
    });
    check('Six identical "Save" buttons → one line with all ids', /\[\d+(,\d+){5}\] button \\"Save\\" ×6 \(any of these ids works\)/.test(first) && (first.match(/button \\"Save\\"/g) || []).length === 1, first.slice(0, 900));
    check('Clicking one of the grouped ids hits the right button', pages['https://jobs.example.com/list'].log.includes('save2'));
  }

  // ---------- 7. a new page always gets a full snapshot; the base is never trimmed ----------
  {
    const form = n => `<!doctype html><html><head><title>Form ${n}</title></head><body><main><h1>Form ${n}</h1>${Array.from({ length: 8 }, (_, i) => `<label for="f${i}">Field ${i}</label><input id="f${i}">`).join('')}</main></body></html>`;
    const pages = { 'https://a.example.com/1': makePage(form(1), 'https://a.example.com/1'), 'https://a.example.com/2': makePage(form(2), 'https://a.example.com/2') };
    const { agentReqs } = await runAgentOn(pages, 'https://a.example.com/1', {
      settings: { learnSites: false },
      plan: [
        ...Array.from({ length: 6 }, (_, k) => ({ id }) => ['type', { id: id(`Field ${k}`), text: 'v' + k }]),
        () => ['navigate', { url: 'https://a.example.com/2' }],
        () => ['done', { summary: 'ok' }]
      ]
    });
    const navRes = toolResults(agentReqs[7])[0];
    check('New page → full snapshot', /Interactive elements:/.test(navRes) && /Form 2/.test(navRes));
    const before = JSON.stringify(agentReqs[6].messages);
    check('After many steps the base snapshot is still there and old change lists are trimmed', /initial page snapshot removed/.test(before) === false && /Interactive elements:/.test(before) && /older page snapshot removed/.test(before));
  }

  // ---------- 8. WebMCP: the site's own tools ----------
  {
    const html = `<!doctype html><html><head><title>Acme Careers</title></head><body><main><h1>Careers</h1>
      <form toolname="subscribe_alerts" tooldescription="Subscribe to job alerts">
        <label for="ae">Email</label><input id="ae" name="email" toolparamdescription="Where to send alerts" required>
        <select name="freq"><option value="daily">daily</option><option value="weekly">weekly</option></select>
        <button type="submit">Subscribe</button></form>
      <form toolname="quick_note" toolautosubmit><input name="text" aria-label="Note"><button>Send</button></form>
      </main><script>window.log=[]; document.forms[0].addEventListener('submit', e => { e.preventDefault(); log.push('subscribed'); }); document.forms[1].addEventListener('submit', e => { e.preventDefault(); log.push('note:' + document.forms[1].querySelector('[name=text]').value); });</script></body></html>`;
    const setup = w => {
      // Like Chrome's built-in navigator.modelContext; Sidekick's capture script runs first (document_start).
      const registry = [];
      w.navigator.modelContext = { registerTool(t) { registry.push(t); }, unregisterTool() {} };
      w.eval(CAPTURE);
      w.navigator.modelContext.registerTool({ name: 'search_jobs', description: 'Search open roles', inputSchema: { type: 'object', properties: { query: { type: 'string' }, remote: { type: 'boolean' } }, required: ['query'] }, annotations: { readOnlyHint: true }, execute: async ({ query }) => ({ content: [{ type: 'text', text: `3 roles match "${query}": Intern, SWE I, SWE II` }] }) });
      w.navigator.modelContext.registerTool({ name: 'save_job', description: 'Save a job to your list', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] }, execute: async ({ job_id }) => { w.log.push('saved:' + job_id); return 'Saved.'; } });
    };
    const pages = { 'https://careers.acme.com/': makePage(html, 'https://careers.acme.com/', setup) };
    const P = pages['https://careers.acme.com/'];
    const { agentReqs, asked } = await runAgentOn(pages, 'https://careers.acme.com/', {
      approvals: [false, true, true],
      settings: { learnSites: false },
      plan: [
        () => ['site_tool', { name: 'search_jobs', arguments: { query: 'intern' } }],
        () => ['site_tool', { name: 'save_job', arguments: { job_id: 'j1' } }],
        () => ['site_tool', { name: 'subscribe_alerts', arguments: { email: 'ulugbek@example.edu', freq: 'weekly' } }],
        () => ['site_tool', { name: 'quick_note', arguments: { text: 'hello' } }],
        () => ['site_tool', { name: 'search_jobs', arguments: {} }],
        () => ['done', { summary: 'ok' }]
      ]
    });
    const first = JSON.stringify(agentReqs[0].messages[0]);
    check('Snapshot lists the site\'s agent tools with their arguments', /This site offers tools for AI agents \(WebMCP\)/.test(first) && /- search_jobs\(query: string, remote\?: boolean\): Search open roles \[read-only\]/.test(first) && /- subscribe_alerts\(email: string, freq\?: \\"daily\\"\|\\"weekly\\"\): Subscribe to job alerts/.test(first), first.slice(0, 1200));
    const r1 = toolResults(agentReqs[1])[0];
    check('Read-only tool runs without asking; its result comes back fenced', /3 roles match \\?"intern\\?"/.test(r1) && /untrusted_content/.test(r1) && !asked.some(a => /search_jobs/.test(a.title)), r1.slice(0, 400));
    check('Other tools need approval; declined = not run', /save_job/.test(asked[0]?.title) && !P.log.includes('saved:j1') && /declined/.test(toolResults(agentReqs[2])[0]));
    const d = P.document;
    check('Declarative form tool: filled after approval, not submitted on its own', d.forms[0].querySelector('[name=email]').value === 'ulugbek@example.edu' && d.forms[0].querySelector('[name=freq]').value === 'weekly' && !P.log.includes('subscribed') && /Not submitted yet/.test(toolResults(agentReqs[3])[0]));
    check('Form tool marked auto-submit: submitted after approval', P.log.includes('note:hello') && /submits the form/.test(asked[2]?.title || ''));
    check('Missing required arguments are caught before calling the site', /Missing required argument: query/.test(toolResults(agentReqs[5])[0]));
  }

  // ---------- 9. page structure ----------
  {
    const w = makePage(JOB.replace('<form id="app" hidden>', '<form id="app">'), 'https://x.example.com/');
    loadScripts(w, ['page-agent.js']);
    const snap = w.skPageSnapshot({});
    const L = snap.elements.join('\n');
    check('Elements listed under their section headings', /## Personal info\n\[\d+\] textbox "First Name \*"/.test(L) && /## Questions\n/.test(L), L.slice(0, 600));
    check('aria-describedby help text shown as hint', /textbox:email "Email \*" .*hint: "We'll send updates here"/.test(L));
  }

  // ---------- 10. profile page: Site skills ----------
  {
    const local = makeStore({ profile: PROFILE, adapters: store.data().adapters, siteNotes: store.data().siteNotes });
    const html = fs.readFileSync(srcPath('profile.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
    const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/profile.html' }).window;
    w.chrome = { storage: { local, session: makeStore(), onChanged: { addListener() {} } }, runtime: { getURL: p => p }, tabs: { query: async () => [] } };
    w.fetch = async () => { throw new Error('no network'); };
    const files = [...fs.readFileSync(srcPath('profile.html'), 'utf8').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);
    loadScripts(w, files);
    await sleep(150);
    const box = w.document.querySelector('#sitesList');
    check('Profile page: Site skills shows the shortcut, its steps and the notes', /greenhouse\.io/.test(box.textContent) && /Shortcut: Apply to this job/.test(box.textContent) && /from your profile \(email\)/.test(box.textContent) && /the agent decides each time/.test(box.textContent) && /you approve/.test(box.textContent) && /Note: The Location field/.test(box.textContent), box.textContent.slice(0, 600));
    check('Profile page: table of contents links to Site skills', [...w.document.querySelectorAll('#toc a')].some(a => a.textContent === 'Site skills'));
    box.querySelector('button[aria-label="Delete shortcut"]').click(); await sleep(60);
    box.querySelector('button[aria-label="Delete note"]').click(); await sleep(60);
    check('Profile page: delete a shortcut and a note', !(local.data().adapters || []).length && !local.data().siteNotes?.['greenhouse.io'] && /Nothing yet/.test(w.document.querySelector('#sitesList').textContent));
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
