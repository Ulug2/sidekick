// Regression test for docs/BUGS.md 1: "the job agent asked my high school and graduation year three
// times". A question answered once is answered from memory in every later run, also when it is
// worded differently ("secondary school", "Year of HS graduation"), and the user never sees it again.
// The model is faked; the fake classifier plays the "same question?" role the real one plays.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, makeStore, loadScripts, sleep, sseResponse, anthropicEvents } = H;
const { prep } = require(require('path').join(__dirname, 'engine-test.js'));
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 1200).replace(/\n/g, '\n        ') : ''}`);

const FORM = `<!doctype html><html><head><title>Apply – Acme</title></head><body><main><h1>Education</h1><form>
  <label for="hs">High school</label><input id="hs"><label for="hy">High school graduation year</label><input id="hy">
  <label for="gpa">GPA</label><input id="gpa"></form></main></body></html>`;
const ANSWER = 'Nazarbayev Intellectual School in Almaty, graduated 2022';
const local = makeStore({ anthropicKey: 'k', memoryAuto: true, profile: { fullName: 'Ulugbek Rivera', email: 'u@example.edu' } });
const calls = { classify: 0, file: 0, asks: [], agentSystems: [], toolResults: [] };

// The fake classifier: matches by meaning the way the real one is asked to (only from what's saved).
function classifierReply(body) {
  const user = body.messages[0].content.map ? body.messages[0].content.map(c => c.text).join('') : String(body.messages[0].content);
  if (/You match a form question/.test(body.system)) {
    calls.classify++;
    const q = ((user.match(/<untrusted_content source="the form">\n?([\s\S]*?)\n?<\/untrusted_content>/) || [])[1] || '').trim();
    calls.classifierPrompts = (calls.classifierPrompts || []).concat(user);
    const answered = [];
    const knowsSchool = /High school \(secondary school\) name: Nazarbayev/.test(user) || /A: Nazarbayev Intellectual School/.test(user);
    const knowsYear = /High school graduation year: 2022/.test(user) || /A: 2022/.test(user);
    if (/GPA/.test(q)) return JSON.stringify({ answered: [{ question: q, answer: '3.9', from: 'a guess' }], remaining: [] }); // a made-up value
    if (/secondary school|high school/i.test(q) && !/year|when|finish/i.test(q) && knowsSchool) answered.push({ question: q, answer: 'Nazarbayev Intellectual School (Almaty)', from: 'saved answer' });
    if (/year|when|finish/i.test(q) && /school|HS/i.test(q) && knowsYear) answered.push({ question: q, answer: '2022', from: 'saved answer' });
    return JSON.stringify({ answered, remaining: answered.length ? [] : [q] });
  }
  if (/You file a user's answer/.test(body.system)) {
    calls.file++;
    return JSON.stringify({ pairs: [{ question: 'Which high school did you attend?', answer: 'Nazarbayev Intellectual School (Almaty)' }, { question: 'What year did you graduate from high school?', answer: '2022' }], facts: [{ key: 'highSchool', value: 'Nazarbayev Intellectual School' }, { key: 'highSchoolCity', value: 'Almaty, Kazakhstan' }, { key: 'highSchoolYear', value: '2022' }] });
  }
  return null;
}

async function run(plan) {
  const page = new JSDOM(FORM, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://boards.greenhouse.io/acme/jobs/1' }).window; prep(page);
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/sidepanel.html' }).window;
  w.chrome = {
    storage: { local, session: makeStore(), onChanged: { addListener() {} } },
    tabs: { query: async () => [{ id: 5, windowId: 1, active: true, url: page.location.href, title: page.document.title }], get: async id => ({ id, windowId: 1, active: true, status: 'complete', url: page.location.href, title: page.document.title }), onCreated: { addListener() {}, removeListener() {} }, update: async () => ({}) },
    scripting: { executeScript: async ({ func, args }) => [{ frameId: 0, result: JSON.parse(JSON.stringify((await page.eval(`(${func.toString()})`)(...(args || [])) ) ?? null)) }] },
    runtime: { getURL: p => p, getManifest: () => ({ version: '0.9.6' }) }
  };
  w.fetch = async (u, o) => {
    const body = JSON.parse(o.body);
    { const ck = H.checkerReply(body); if (ck) return ck; }
    const c = classifierReply(body);
    if (c !== null) return sseResponse(anthropicEvents([{ type: 'text', text: c }]));
    if (/reusable operating notes/.test(body.system || '')) return sseResponse(anthropicEvents([{ type: 'text', text: '{"notes":[]}' }]));
    const step = body.messages.filter(m => m.role === 'assistant').length;
    if (step === 0) calls.agentSystems.push(body.system);
    const last = body.messages.at(-1);
    if (last?.role === 'user' && Array.isArray(last.content)) for (const c of last.content) if (c.type === 'tool_result') calls.toolResults.push(JSON.stringify(c.content));
    const all = JSON.stringify(body.messages);
    const id = re => { const m = all.match(new RegExp(String.raw`\[(\d+)\] [a-z:]+ \\"` + re)); return m && m[1]; };
    const [name, input] = plan[step]({ id });
    return sseResponse(anthropicEvents([{ type: 'tool_use', id: `t${step}`, name, input }], { stop: 'tool_use' }));
  };
  loadScripts(w, ['agent.js'], ['runAgent', 'getAnswers', 'getFacts']);
  const ui = {
    signal: new AbortController().signal,
    step: () => ({ waiting() {}, done() {} }), note() {},
    approve: async () => true,
    ask: async q => { calls.asks.push(q); return ANSWER; }
  };
  const r = await w.runAgent('Apply for this job using my profile', ui, { record: false });
  await sleep(150); // learning runs in the background
  return { r, page, w };
}

(async () => {
  // ---------- run 1: the question is asked once and learned ----------
  const r1 = await run([
    () => ['ask_user', { question: 'What high school did you attend, and what year did you graduate?' }],
    ({ id }) => ['fill_fields', { fields: [{ id: id('High school\\\\"'), value: 'Nazarbayev Intellectual School' }, { id: id('High school graduation year'), value: '2022' }] }],
    () => ['done', { summary: 'Filled.' }]
  ]);
  const answers = await r1.w.getAnswers();
  const facts = await r1.w.getFacts();
  check('Run 1: the user is asked once, and the answer is filed as two reusable answers and three facts', calls.asks.length === 1 && answers.length === 2 && ['highSchool', 'highSchoolCity', 'highSchoolYear'].every(k => facts.some(f => f.key === k && f.source === 'application')), JSON.stringify({ asks: calls.asks, answers: answers.map(a => a.question), facts: facts.map(f => f.key) }));

  // ---------- run 2: the same questions in other words: answered from memory, never shown ----------
  const asksBefore = calls.asks.length;
  const r2 = await run([
    () => ['ask_user', { question: 'Name of your secondary school?' }],
    () => ['ask_user', { question: 'Year of HS graduation' }],
    () => ['done', { summary: 'Filled.' }]
  ]);
  check('Run 2 (the bug): reworded questions about high school are answered from memory; the user sees nothing', calls.asks.length === asksBefore && calls.toolResults.some(t => /Answered from Sidekick's memory[\s\S]*Nazarbayev Intellectual School/.test(t)) && calls.toolResults.some(t => /Answered from Sidekick's memory[\s\S]*2022/.test(t)), JSON.stringify({ asks: calls.asks, results: calls.toolResults.slice(-3) }));
  check('Run 2: the question reaches the classifier fenced as untrusted (it was worded from a web form)', (calls.classifierPrompts || []).every(p => /<untrusted_content source="the form">/.test(p)) && (calls.classifierPrompts || []).length >= 2);
  check('Run 2: the agent already knows the facts and saved answers in its instructions', /What they've already told Sidekick[\s\S]*High school \(secondary school\) name: Nazarbayev Intellectual School[\s\S]*What year did you graduate from high school\? → 2022/.test(calls.agentSystems.at(-1) || ''), (calls.agentSystems.at(-1) || '').slice(-900));

  // ---------- run 3: the exact wording again: matched in code, no model call at all ----------
  const classifyBefore = calls.classify;
  await run([
    () => ['ask_user', { question: 'What year did you graduate from high school?' }],
    () => ['done', { summary: 'ok' }]
  ]);
  check('Run 3: an exact repeat is matched in code (no classifier call, nothing asked)', calls.classify === classifyBefore && calls.asks.length === asksBefore, `classify ${classifyBefore}→${calls.classify}, asks ${calls.asks.length}`);

  // ---------- a value the classifier made up is not used; the user is asked ----------
  {
    const before = calls.asks.length;
    await run([() => ['ask_user', { question: 'What is your cumulative GPA?' }], () => ['done', { summary: 'ok' }]]);
    check('A classifier answer that is not a saved value (3.9, made up) is thrown away and the user is asked', calls.asks.length === before + 1 && calls.asks.at(-1) === 'What is your cumulative GPA?');
  }

  // ---------- human steps always reach the user; nothing is learned from "done" ----------
  const fileBefore = calls.file;
  await run([
    () => ['ask_user', { question: 'Please sign in to Acme, then tell me when you are done.' }],
    () => ['done', { summary: 'ok' }]
  ]);
  check('A sign-in request always reaches the user and is not filed as an answer', calls.asks.at(-1) === 'Please sign in to Acme, then tell me when you are done.' && calls.file === fileBefore);

  // ---------- the Memory page shows and edits what was learned ----------
  {
    const fs = require('fs');
    const html = fs.readFileSync(H.srcPath('memory.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
    const pw = new JSDOM(html, { runScripts: 'outside-only', url: 'chrome-extension://abc/memory.html' }).window;
    pw.chrome = { storage: { local, session: makeStore(), onChanged: { addListener() {} } }, runtime: { getURL: p => p } };
    loadScripts(pw, ['memory.js'], []);
    await sleep(150);
    const d = pw.document;
    check('Memory page: learned facts in the editable fields (with where they came from), profile facts read-only, saved answers listed', d.querySelector('[data-key="highSchool"]').value === 'Nazarbayev Intellectual School' && /from an application/.test(d.querySelector('[data-key="highSchool"]').parentElement.textContent) && /Full name\s*Ulugbek Rivera/.test(d.querySelector('#profileFacts').textContent) && d.querySelectorAll('#answerList li').length === 2 && /2 saved/.test(d.querySelector('#answerCount').textContent));
    const yr = d.querySelector('[data-key="highSchoolYear"]'); yr.value = '2021'; yr.dispatchEvent(new pw.Event('input'));
    await sleep(700);
    const li = d.querySelector('#answerList li'); li.querySelector('button').click();
    await sleep(80);
    check('Memory page: editing a fact saves it as yours; deleting an answer removes it', local.data().facts.highSchoolYear.value === '2021' && local.data().facts.highSchoolYear.source === 'you' && local.data().answers.length === 1, JSON.stringify(local.data().facts));
    const s = d.querySelector('[data-key="gpa"]'); s.value = '4111 1111 1111 1111'; s.dispatchEvent(new pw.Event('input'));
    await sleep(700);
    check('Memory page: a card-number-looking value is refused, never stored', !local.data().facts.gpa && /never stores those/.test(d.querySelector('#saveState').textContent));
  }

  console.log(results.join('\n'));
  const passed = results.filter(r => r.startsWith('PASS')).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.log(results.join('\n')); console.log('CRASH', e.stack); process.exit(1); });
