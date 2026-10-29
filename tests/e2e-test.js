const __notesReq = body => /You keep the pinned notes|get to know its user over time/.test((body && (body.system || body.instructions)) || '');
const __notesRes = (body, H2) => /get to know/.test(body.system || body.instructions || '') ? (body.input ? H2.sseResponse(H2.openaiEvents({ text: '{"add":[],"update":[],"remove":[],"about":null}' })) : H2.sseResponse(H2.anthropicEvents([{ type: 'text', text: '{"add":[],"update":[],"remove":[],"about":null}' }]))) : (body.input ? H2.sseResponse(H2.openaiEvents({ text: '{"notes":[]}' })) : H2.sseResponse(H2.anthropicEvents([{ type: 'text', text: '{"notes":[]}' }])));
const { JSDOM } = require('jsdom');
const fs = require('fs'); const dir = require('path').join(__dirname, '..', 'extension') + '/';
const { FORM, prep } = require(require('path').join(__dirname, 'engine-test.js'));
const H = require(require('path').join(__dirname, 'helpers.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  (' + x + ')' : ''}`);

function makeStore(init = {}) {
  let data = JSON.parse(JSON.stringify(init));
  return { data: () => data,
    get: async k => { if (k == null) return { ...data }; if (typeof k === 'string') return k in data ? { [k]: data[k] } : {}; if (Array.isArray(k)) return Object.fromEntries(k.filter(x => x in data).map(x => [x, data[x]])); const o = {}; for (const [kk, d] of Object.entries(k)) o[kk] = kk in data ? data[kk] : d; return o; },
    set: async o => { data = { ...data, ...JSON.parse(JSON.stringify(o)) }; }, remove: async k => { for (const x of [].concat(k)) delete data[x]; } };
}

// ---- the "web page": job posting (top frame) + application form (iframe, frameId 7) ----
const TOP = `<!doctype html><html><head><title>Software Engineer Intern - Acme Careers</title></head><body>
<main><h1>Software Engineer Intern</h1><p>Acme is hiring interns to build React Native apps. Requirements: TypeScript, React. Location: New York.</p>
<button id="apply" onclick="window.applyClicked=true">Apply for this job</button>
<button id="danger" onclick="window.deleted=true">Delete my account</button></main></body></html>`;
const top = new JSDOM(TOP, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://careers.acme.com/jobs/42' });
const frame = new JSDOM(FORM, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://boards.greenhouse.io/acme/jobs/42' });
prep(top.window); prep(frame.window);
frame.window.document.getElementById('submit').addEventListener('click', () => {
  frame.window.document.body.innerHTML = '<h1>Thank you for applying!</h1><p>We received your application.</p>';
});
const frames = { 0: top.window, 7: frame.window };
const runIn = async (w, func, args) => JSON.parse(JSON.stringify(await w.eval(`(${func.toString()})`)(...(args || [])) ?? null));

// ---- fake Claude: decides each step from the latest snapshot ----
const apiCalls = [];
let scenario = 'apply';
function lastText(messages) {
  const m = messages.at(-1);
  if (typeof m.content === 'string') return m.content;
  return m.content.map(b => b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content.map(c => c.text || '').join('') : '').join('\n');
}
const idFor = (snap, re) => { const line = snap.split('\n').find(l => /^\[[\d:]+\]/.test(l) && re.test(l)); return line && line.match(/^\[([\d:]+)\]/)[1]; };
function decide(messages) {
  const step = messages.filter(m => m.role === 'assistant').length;
  // Like a real model, use the most recent page snapshot anywhere in the conversation.
  const snap = [...messages].reverse().map(m => lastText([m])).find(t => t.includes('Interactive elements')) || '';
  const call = (name, input, text) => ({ text, name, input });
  if (scenario === 'deny') {
    if (step === 0) return call('click', { id: idFor(snap, /Delete my account/), description: 'Delete the account', final_action: false }, 'Deleting the account as asked.');
    return call('done', { summary: 'You declined, so I left the account alone.' });
  }
  if (scenario === 'stop') return call('wait', { seconds: 1 }, 'Waiting for the page.');
  const plan = [
    () => call('read_text', {}, 'Reading the job description first.'),
    () => call('click', { id: idFor(snap, /Apply for this job/), description: 'Open the application form', final_action: false }, 'Opening the application.'),
    () => call('type', { id: idFor(snap, /"First Name"/), text: 'Ulugbek' }),
    () => call('type', { id: idFor(snap, /"Email"/), text: 'ulugbek@example.edu' }),
    () => call('upload_file', { id: idFor(snap, /file "Resume/), file: 'resume' }),
    () => call('select_option', { id: idFor(snap, /How did you hear/), option: 'LinkedIn' }),
    () => call('select_option', { id: idFor(snap, /combobox "Location"/), option: 'New York' }),
    () => call('set_checked', { id: idFor(snap, /radio "Yes"/), checked: true }),
    () => call('type', { id: idFor(snap, /Why do you want/), text: 'I build React Native apps in TypeScript and want to ship to real users at Acme.' }),
    () => call('type', { id: idFor(snap, /Create a password/), text: 'hunter2' }, 'Trying the password field.'),
    () => call('ask_user', { question: 'The form wants an account password. Please type it yourself, then tell me to continue.' }),
    () => call('click', { id: idFor(snap, /Submit application/), description: 'Submit the application. Authorized to work: Yes. Heard via LinkedIn.', final_action: true }, 'Everything is filled. Submitting.'),
    () => call('log_application', { company: 'Acme', role: 'Software Engineer Intern', status: 'submitted' }),
    () => call('done', { summary: '**Applied** to Software Engineer Intern at Acme. Answered work authorization: Yes.' })
  ];
  return plan[step]();
}

(async () => {
  const local = makeStore({ anthropicKey: 'sk-ant', provider: 'anthropic', profile: {
    fullName: 'Ulugbek K', email: 'ulugbek@example.edu', workAuthorized: 'Yes', howHeard: 'LinkedIn',
    resume: { name: 'Ulugbek_Resume.pdf', type: 'application/pdf', size: 10, text: 'Resume text: React Native, TypeScript', dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 resume').toString('base64'), updatedAt: Date.now() } } });
  const session = makeStore();
  const html = fs.readFileSync(dir + 'sidepanel.html', 'utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
  const panel = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/sidepanel.html' });
  const w = panel.window;
  const created = [];
  w.chrome = {
    storage: { local, session, onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 5, windowId: 1, active: true, url: 'https://careers.acme.com/jobs/42', title: 'Acme' }],
      get: async id => ({ id, windowId: 1, active: true, status: 'complete', url: 'https://careers.acme.com/jobs/42', title: 'Acme' }),
      captureVisibleTab: async () => 'data:image/jpeg;base64,SHOT',
      update: async () => ({}), goBack: async () => {}, create: async o => { created.push(o.url); return { id: 99 }; },
      onCreated: { addListener() {}, removeListener() {} }
    },
    scripting: { executeScript: async ({ target, func, args }) => {
      if (target.allFrames) return Promise.all(Object.entries(frames).map(async ([fid, fw]) => ({ frameId: +fid, result: await runIn(fw, func, args) })));
      const fid = (target.frameIds || [0])[0];
      return [{ frameId: fid, result: await runIn(frames[fid], func, args) }];
    } },
    runtime: { openOptionsPage() {}, getURL: p => 'chrome-extension://abc/' + p }
  };
  w.ResizeObserver = class { observe() {} };
  w.navigator.clipboard = { writeText: async () => {} };
  w.fetch = async (url, o) => {
    const body = JSON.parse(o.body); { const __ck = H.checkerReply(body); if (__ck) return __ck; }
    if (__notesReq(body)) return __notesRes(body, H);
    apiCalls.push(body);
    const d = decide(body.messages);
    const content = [{ type: 'thinking', signature: 'sig-' + apiCalls.length }];
    if (d.text) content.push({ type: 'text', text: d.text });
    content.push({ type: 'tool_use', id: 'tu_' + apiCalls.length, name: d.name, input: d.input });
    return H.sseResponse(H.anthropicEvents(content, { stop: 'tool_use' }));
  };
  H.loadScripts(w, ['vendor/marked.js','vendor/purify.min.js','vendor/katex.min.js','vendor/highlight.min.js','vendor/math.js','vendor/nerdamer.js','ai.js','guard.js','profile-core.js','memory.js','skills.js','docs.js','web.js','screen.js','calc.js','page-agent.js','cdp.js','adapters.js','agent.js','session.js','brain.js','sidepanel.js']);
  await sleep(80);
  const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(25); } return null; };
  const F = frame.window.document;

  // ---------- run 1: full application ----------
  $('#agentToggle').click();
  check('Agent toggle shows agent quick actions', w.document.body.classList.contains('agent-mode') && $('#input').placeholder.includes('what to do'));
  $('.chip[data-action="apply"]').click();

  const up = await until(() => $('.agent-card.approve:not(.answered)'));
  check('First resume upload on a site asks you first', !!up && /Attach your resume \(.+\) on greenhouse\.io\?/.test(up.querySelector('.ac-title').textContent), up?.textContent);
  up?.querySelector('.ac-allow').click();

  const q = await until(() => $('.agent-card.question:not(.answered)'));
  check('Agent asks the user (password) and pauses', !!q && q.textContent.includes('type it yourself'));
  check('While waiting, send button sends the answer (not stop)', !$('#send').classList.contains('stop'));
  check('Password guard blocked the model', $$('.step.fail .st-detail').some(d => /never fills/.test(d.textContent)) && F.getElementById('pw').value === '');
  $('#input').value = 'Done, I typed it. Continue.'; $('#input').dispatchEvent(new w.Event('input'));
  $('#input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  const appr = await until(() => $('.agent-card.approve:not(.answered)'));
  check('Final submit requires approval', !!appr && /Submit application/.test(appr.querySelector('.ac-title').textContent) && /Authorized to work: Yes/.test(appr.textContent));
  check('Nothing submitted before approval', !frame.window.submitClicked);
  appr.querySelector('.ac-allow').click();

  await until(() => $('.agent-run.finished'));
  check('Applied: form filled correctly in the iframe', frame.window.submitClicked === true);
  const filledEvents = frame.window.events.join(' | ');
  check('Values typed (React-safe events)', /fn=Ulugbek/.test(filledEvents) && /em=ulugbek@example.edu/.test(filledEvents) && /why=I build/.test(filledEvents));
  check('Resume uploaded, dropdowns + radio set', frame.window.chosen === 'New York, NY');
  check('Clicked Apply in top frame', top.window.applyClicked === true);
  check('Application logged', local.data().applications?.[0]?.company === 'Acme' && local.data().applications[0].url.includes('acme'));
  check('Summary rendered as Markdown', $('.agent-run.finished .md strong')?.textContent === 'Applied');
  const steps = $$('.agent-run .step:not(.note) .st-text').map(e => e.textContent);
  check('Readable step list', steps.includes('Open the application form') && steps.some(s => /Attach your resume/.test(s)) && steps.some(s => /Choose “New York”/.test(s)), steps.length + ' steps');
  check('Progress notes from the model shown', $$('.step.note').some(n => n.textContent === 'Reading the job description first.'));
  check('Long run collapsed with toggle', !!$('.agent-run.collapsed') && !!$('.steps-toggle'));

  // API-level checks
  const c2 = apiCalls[1];
  check('Thinking blocks sent back unchanged', c2.messages[1].content[0].type === 'thinking' && c2.messages[1].content[0].signature === 'sig-1');
  check('Tool results use tool_result blocks', c2.messages[2].content[0].type === 'tool_result' && c2.messages[2].content[0].tool_use_id === 'tu_1');
  check('Agent may batch several actions per turn (parallel tool use on)', apiCalls[0].tool_choice?.disable_parallel_tool_use === false);
  check('System prompt includes profile + job playbook', /Ulugbek K/.test(apiCalls[0].system) && /Job applications/.test(apiCalls[0].system) && /Resume text: React Native/.test(apiCalls[0].system));
  const agentCalls = apiCalls.filter(c => (c.tools || []).some(t => t.name === 'click'));
  const late = JSON.stringify(agentCalls.at(-1).messages);
  const learnCall = apiCalls.find(c => /reusable operating notes/.test(c.system || ''));
  check('After a run with problems, site notes are learned with the fast model (no personal answers sent)', learnCall && learnCall.model === 'claude-haiku-5-5' && /greenhouse\.io/.test(JSON.stringify(learnCall.messages)) && !/I build|hunter2|ulugbek@example|Ulugbek”/.test(JSON.stringify(learnCall.messages)) && /Type into “First Name”/.test(JSON.stringify(learnCall.messages)), JSON.stringify(learnCall?.messages).slice(0, 1500));
  check('Old snapshots trimmed to save tokens; the base snapshot that change lists refer to is kept', /older page snapshot removed/.test(late) && (/initial page snapshot removed/.test(late) || /Interactive elements:/.test(late)) && /Changes since then|Interactive elements:/.test(late));
  check('Frame elements addressed as frame:id', JSON.stringify(apiCalls.map(c => c.messages.at(-1))).includes('[7:1] textbox'));
  const uploadReq = apiCalls.find((c, i) => i > 0 && JSON.stringify(c.messages.at(-1)).includes('Attached Ulugbek_Resume.pdf'));
  check('Resume upload confirmed to the model', !!uploadReq);

  // chat saved + restore
  const idx = local.data().chatIndex;
  const saved = local.data()['chat:' + idx[0].id];
  check('Agent run saved to history', saved.messages[1].agentSteps?.length === steps.length && saved.messages[0].display.agent === true);

  // ---------- run 2: risky word forces approval even when model says not final; deny ----------
  scenario = 'deny'; apiCalls.length = 0;
  $('#input').value = 'delete my account'; $('#input').dispatchEvent(new w.Event('input')); $('#send').click();
  const appr2 = await until(() => $('.agent-card.approve:not(.answered)'));
  check('Risky button needs approval even if model says not final', !!appr2 && /Delete my account/.test(appr2.textContent));
  appr2.querySelector('.ac-deny').click();
  await until(() => $$('.agent-run.finished').length === 2);
  check('Declined action never happens', !top.window.deleted);
  check('Model is told not to retry', JSON.stringify(apiCalls.at(-1).messages.at(-1)).includes("declined this action. Don't retry"));

  // ---------- run 3: stop button ----------
  scenario = 'stop';
  $('#input').value = 'just wait around'; $('#input').dispatchEvent(new w.Event('input')); $('#send').click();
  await until(() => $$('.agent-run .step.running').length > 0);
  $$('.agent-stop').at(-1).click();
  const fin = await until(() => $$('.agent-run.finished').length === 3);
  check('Stop ends the run', !!fin && $$('.agent-run').at(-1).querySelector('.agent-status').textContent === 'Stopped');
  check('Composer back to normal after stop', !$('#send').classList.contains('stop'));

  // ---------- restore from history ----------
  const html2 = html;
  const p2 = new JSDOM(html2, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/sidepanel.html' });
  const w2 = p2.window; w2.chrome = w.chrome; w2.ResizeObserver = w.ResizeObserver; w2.fetch = w.fetch;
  H.loadScripts(w2, ['vendor/marked.js','vendor/purify.min.js','vendor/katex.min.js','vendor/highlight.min.js','vendor/math.js','vendor/nerdamer.js','ai.js','guard.js','profile-core.js','memory.js','skills.js','docs.js','web.js','screen.js','calc.js','page-agent.js','cdp.js','adapters.js','agent.js','session.js','brain.js','sidepanel.js']);
  await sleep(150);
  check('Reopened panel starts a new chat', !w2.document.querySelector('.agent-run'));
  w2.document.querySelector('#historyBtn').click(); await sleep(60);
  w2.document.querySelector('.chat-row .chat-open').click(); await sleep(100);
  check('Opening the chat from history restores agent runs with steps', w2.document.querySelectorAll('.agent-run.finished').length === 3 && w2.document.querySelector('.agent-run .md strong')?.textContent === 'Applied');

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
