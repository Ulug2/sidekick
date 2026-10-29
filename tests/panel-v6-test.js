const __notesReq = body => /You keep the pinned notes|get to know its user over time/.test((body && (body.system || body.instructions)) || '');
const __notesRes = (body, H2) => /get to know/.test(body.system || body.instructions || '') ? (body.input ? H2.sseResponse(H2.openaiEvents({ text: '{"add":[],"update":[],"remove":[],"about":null}' })) : H2.sseResponse(H2.anthropicEvents([{ type: 'text', text: '{"add":[],"update":[],"remove":[],"about":null}' }]))) : (body.input ? H2.sseResponse(H2.openaiEvents({ text: '{"notes":[]}' })) : H2.sseResponse(H2.anthropicEvents([{ type: 'text', text: '{"notes":[]}' }])));
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, sleep, makeStore, sseResponse, anthropicEvents, loadScripts, fs, DIR, PANEL_SCRIPTS } = H;
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 500).replace(/\n/g, '\n        ') : ''}`);

const JOB_URL = 'https://boards.greenhouse.io/acme/jobs/42';
const PAGE = `<!doctype html><html><head><title>Acme Careers</title></head><body><main><h1>Software Engineer Intern</h1><p>Build React Native apps.</p><button id="ok" onclick="window.clicked=1">Save job</button></main></body></html>`;

(async () => {
  const page = new JSDOM(PAGE, { runScripts: 'dangerously', pretendToBeVisual: true, url: JOB_URL });
  const pw = page.window;
  pw.Element.prototype.getBoundingClientRect = () => ({ left: 10, top: 100, width: 100, height: 20, right: 110, bottom: 120 });
  Object.defineProperty(pw.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, configurable: true });
  pw.PointerEvent = pw.MouseEvent; pw.CSS = { escape: s => s }; pw.Element.prototype.scrollIntoView = () => {};

  const local = makeStore({ anthropicKey: 'sk-ant', provider: 'anthropic', trustedInput: false, profile: { fullName: 'Ulugbek Rivera', useInChat: true } });
  const session = makeStore();
  const html = fs.readFileSync(DIR + 'sidepanel.html', 'utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/sidepanel.html' });
  const w = dom.window;
  H.basicDom(w);
  const spoken = [];
  w.speechSynthesis = { speaking: false, speak: u => spoken.push(u.text), cancel() {}, getVoices: () => [] };
  w.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  const reqs = [];
  let script = []; // queue of responses for chat requests
  w.chrome = {
    storage: { local, session, onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 5, windowId: 1, active: true, url: JOB_URL, title: 'Acme Careers' }],
      get: async id => ({ id, windowId: 1, active: true, status: 'complete', url: JOB_URL, title: 'Acme Careers' }),
      create: async o => ({ id: 9, url: o.url }),
      captureVisibleTab: async () => 'data:image/jpeg;base64,AAAA',
      onCreated: { addListener() {}, removeListener() {} }
    },
    scripting: { executeScript: async ({ func, args }) => [{ frameId: 0, result: JSON.parse(JSON.stringify(await pw.eval(`(${func.toString()})`)(...(args || [])) ?? null)) }] },
    runtime: { openOptionsPage() {}, getURL: p => 'chrome-extension://abc/' + p }
  };
  w.fetch = async (u, o) => {
    const body = JSON.parse(o.body);
    if (__notesReq(body)) return __notesRes(body, H);
    reqs.push(body);
    const isAgent = /browser agent/.test(body.system);
    const next = isAgent ? script.agent.shift() : script.chat.shift();
    if (!next) throw new Error('no scripted reply for ' + (isAgent ? 'agent' : 'chat'));
    return sseResponse(anthropicEvents(next.blocks, { stop: next.stop || 'end_turn' }), { delay: 1 });
  };
  loadScripts(w, PANEL_SCRIPTS);
  await sleep(150);
  const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(20); } return null; };
  const ask = async text => { $('#input').value = text; $('#input').dispatchEvent(new w.Event('input')); $('#send').click(); };

  // ---------- greeting + page-aware suggestions ----------
  check('Greets you by name', /^(Good (morning|afternoon|evening)|Working late), Ulugbek\.$/.test($('#greeting')?.textContent), $('#greeting')?.textContent);
  const sugs = $$('.suggestion').map(b => b.textContent);
  check('Suggestions fit the page (job posting)', sugs[0] === 'How well do I fit this role?' && sugs.includes('Apply to this job') && sugs.includes('What do you know about me?'), sugs.join(' | '));

  // ---------- chat turn with tools, memory, sources ----------
  script = {
    chat: [
      { stop: 'tool_use', blocks: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 't1', name: 'calculate', input: { lines: ['1240 * 1.07'] } }] },
      { stop: 'tool_use', blocks: [{ type: 'tool_use', id: 't2', name: 'remember', input: { fact: 'Budget for laptop is $1,240' } }] },
      { blocks: [
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'PA sales tax' } },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
        { type: 'text', text: 'With 7% tax that is **$1,326.80**.', citations: [{ type: 'web_search_result_location', url: 'https://www.revenue.pa.gov/tax', title: 'PA Sales Tax', cited_text: '6%' }] }
      ] }
    ],
    agent: []
  };
  await ask('My laptop budget is $1240, what is that with 7% tax?');
  await until(() => $$('.msg.ai .actions').length === 1);
  const chips = $$('.tool-chip').map(c => c.textContent);
  check('Tool chips: calculator with result, memory, web search', /Calculated.*1326\.8/.test(chips[0]) && /Saved to memory.*Budget for laptop/.test(chips[1]) && /Searched the web.*PA sales tax/.test(chips[2]), chips.join(' | '));
  check('Answer streamed with both rounds', /Let me check\.[\s\S]*1,326\.80/.test($('.msg.ai .md').textContent));
  check('Sources shown with host names', $('.sources .source span')?.textContent === 'revenue.pa.gov' && $('.sources .source').href === 'https://www.revenue.pa.gov/tax');
  check('Memory actually saved', local.data().memories?.[0]?.text === 'Budget for laptop is $1,240');
  $('.tc-undo').click(); await sleep(50);
  check('Undo removes the memory', !(local.data().memories || []).length && $('.tool-chip.undone') !== null);
  const info = $$('.act').find(b => /Details/.test(b.title));
  info.click();
  const tv = $('.trace');
  check('Details: model, route reason, tools, tokens', !tv.classList.contains('hidden') && /claude-haiku-5-5 · fast \(everyday question\)/.test(tv.textContent) && /calculate/.test(tv.textContent) && /in/.test(tv.textContent), tv.textContent);
  check('Tier tag shown', $('.tier-tag')?.textContent === 'fast');

  // ---------- read aloud ----------
  $$('.act').find(b => /Read aloud/.test(b.title)).click();
  check('Read aloud speaks plain text (no Markdown)', spoken[0] === 'Let me check. With 7% tax that is $1,326.80.', spoken[0]);

  // ---------- retry with smart model ----------
  script.chat.push({ blocks: [{ type: 'text', text: 'Smart answer: $1,326.80.', citations: [{ type: 'web_search_result_location', url: 'https://www.revenue.pa.gov/tax', title: 'PA Sales Tax', cited_text: '6%' }] }] });
  $$('.act').find(b => /Try again/.test(b.title)).click();
  await until(() => /Smart answer/.test($('.msg.ai:last-child .md')?.textContent || ''));
  await until(() => $$('.msg.ai .actions').length === 1);
  check('Retry uses the smart model and replaces the answer', reqs.at(-1).model === 'claude-sonnet-5-5' && $$('.msg.ai').length === 1 && $$('.msg.user').length === 1);

  // ---------- mode badge ----------
  check('Badge starts on Auto', $('#modelBadge').textContent === 'Auto');
  $('#modelBadge').click(); await sleep(30);
  $('#modelBadge').click(); await sleep(30);
  check('Badge cycles to Smart', $('#modelBadge').textContent === 'Smart' && local.data().routing === 'smart');
  script.chat.push({ blocks: [{ type: 'text', text: 'Hello!' }] });
  await ask('hi');
  await until(() => $$('.msg.ai .actions').length === 2);
  check('Forced smart mode applies even to "hi"', reqs.at(-1).model === 'claude-sonnet-5-5');
  await local.set({ routing: 'auto' });

  // ---------- operate_browser from chat ----------
  script.chat.push({ stop: 'tool_use', blocks: [{ type: 'tool_use', id: 'op1', name: 'operate_browser', input: { task: 'Click Save job' } }] });
  script.agent.push(
    { stop: 'tool_use', blocks: [{ type: 'tool_use', id: 'a1', name: 'click', input: { id: '1', description: 'Save the job', final_action: false } }] },
    { stop: 'tool_use', blocks: [{ type: 'tool_use', id: 'a2', name: 'done', input: { summary: 'Saved the job.' } }] }
  );
  script.chat.push({ blocks: [{ type: 'text', text: 'Done — I saved that job for you.' }] });
  await ask('save this job for me');
  await until(() => $$('.msg.ai .actions').length === 3, 10000);
  const last = $$('.msg.ai').at(-1);
  check('Chat hands off to the agent: nested card inside the reply', !!last.querySelector('.agent-run.nested.finished') && pw.clicked === 1 && /saved that job/.test(last.querySelector(':scope > .md').textContent));
  check('Agent got its own prompt with your name', /Ulugbek/.test(reqs.find(r => /browser agent/.test(r.system)).system));

  // ---------- greeting comes back on New chat; restore keeps sources + details ----------
  await sleep(100);
  const chatId = local.data().chatIndex[0].id;
  $('#clear').click(); await sleep(80);
  check('New chat shows the greeting again', !!$('#greeting'));
  await w.eval('openChat')(chatId); await sleep(80);
  check('Reopened chat keeps sources, details and the agent card', $$('.sources .source').length === 1 && $$('.trace').length === 3 && !!$('.agent-run.nested.finished'));

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
