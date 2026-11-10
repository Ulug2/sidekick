const { srcPath } = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM } = require('jsdom');
const fs = require('fs'); const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  (' + x + ')' : ''}`);
function makeStore(init = {}) { let data = JSON.parse(JSON.stringify(init)); return { data: () => data,
  get: async k => { if (k == null) return { ...data }; if (typeof k === 'string') return k in data ? { [k]: data[k] } : {}; if (Array.isArray(k)) return Object.fromEntries(k.filter(x => x in data).map(x => [x, data[x]])); const o = {}; for (const [kk, d] of Object.entries(k)) o[kk] = kk in data ? data[kk] : d; return o; },
  set: async o => { data = { ...data, ...JSON.parse(JSON.stringify(o)) }; }, remove: async k => { for (const x of [].concat(k)) delete data[x]; } }; }

(async () => {
  // ---------- OpenAI tool-calling adapter ----------
  {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const w = dom.window; let req;
    w.chrome = { storage: { local: makeStore({ openaiKey: 'k', provider: 'openai', reasoning: 'medium' }) } };
    const H = require(require('path').join(__dirname, 'helpers.js'));
    w.fetch = async (u, o) => { req = JSON.parse(o.body); return H.sseResponse(H.openaiEvents({ toolCall: { id: 'call_9', name: 'click', args: { id: '7:3', description: 'x', final_action: false } } })); };
    H.loadScripts(w, ['ai.js'], ['callAgentModel']);
    const transcript = [
      { role: 'user', text: 'Task: apply' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'screenshot', args: {} }] },
      { role: 'tool', results: [{ id: 'call_1', name: 'screenshot', text: 'Screenshot attached.', images: ['data:image/jpeg;base64,AAA'] }] }
    ];
    const r = await w.callAgentModel({ system: 'SYS', transcript, tools: [{ name: 'click', description: 'd', parameters: { type: 'object', properties: {} } }] });
    check('OpenAI: parsed tool call', r.toolCalls[0].name === 'click' && r.toolCalls[0].args.id === '7:3');
    check('OpenAI: function_call + function_call_output items', req.input[1].type === 'function_call' && req.input[1].name === 'screenshot' && req.input[2].type === 'function_call_output' && req.input[2].call_id === 'call_1');
    check('OpenAI: screenshot follows as user image input', req.input[3].role === 'user' && req.input[3].content[1].type === 'input_image' && req.input[3].content[1].image_url.startsWith('data:image/jpeg'));
    check('OpenAI: tools, agent may batch calls, agent effort', req.tools[0].type === 'function' && req.parallel_tool_calls === true && req.reasoning?.effort === 'medium' && /SYS/.test(req.instructions));
    await w.chrome.storage.local.set({ openaiSmart: 'gpt-6-astra' });
    await w.callAgentModel({ system: 'S', transcript, tools: [{ name: 'click', description: 'd', parameters: { type: 'object', properties: {} } }] });
    check('OpenAI: gpt-6-astra can run the agent now (Responses API)', req.model === 'gpt-6-astra' && req.tools.length === 1);
  }

  // ---------- profile page / onboarding ----------
  {
    const local = makeStore({}); const opened = [];
    const html = fs.readFileSync(srcPath('profile.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/profile.html?welcome=1' });
    const w = dom.window; let modelReq;
    w.chrome = { storage: { local, onChanged: { addListener() {} } }, runtime: { getURL: p => p } };
    w.fetch = async (u, o) => { modelReq = JSON.parse(o.body); const json = JSON.stringify({ fullName: 'Ulugbek Rivera', email: 'ulug@example.edu', github: 'https://github.com/example', experience: 'Acme — Intern (2025): built things', skills: 'TypeScript, React Native', city: '' });
      const H = require(require('path').join(__dirname, 'helpers.js'));
      return H.sseResponse(H.anthropicEvents([{ type: 'text', text: 'Here:\n```json\n' + json + '\n```' }])); };
    const pageScripts = [...fs.readFileSync(srcPath('profile.html'), 'utf8').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);
    require(require('path').join(__dirname, 'helpers.js')).loadScripts(w, pageScripts, ['handleResume', 'renderApps', 'profileToPrompt', 'renderMemories', 'renderDocs', 'addMemory', 'getMemories']);
    await sleep(100);
    const $ = s => w.document.querySelector(s);
    check('Onboarding: welcome title + steps + key section', $('#heroTitle').textContent === 'Welcome to Sidekick' && !$('#onboardSteps').hidden && !$('#sec-key').hidden);
    check('All profile sections rendered (4 about you, 5 for applications)', w.document.querySelectorAll('#fieldSections .card').length === 4 && w.document.querySelectorAll('#appSections .card').length === 5 && !!$('#f-eeoRace') && $('#f-eeoRace').value === 'Decline to self-identify');
    check('Table of contents built', w.document.querySelectorAll('#toc a').length >= 12);
    // save key
    $('#keyValue').value = 'sk-ant-xyz'; $('#keySave').click(); await sleep(50);
    check('Key saved from onboarding', local.data().anthropicKey === 'sk-ant-xyz' && $('[data-step="key"]').classList.contains('done'));
    // type a field (autosave)
    $('#f-phone').value = '555-0100'; $('#f-phone').dispatchEvent(new w.Event('input')); $('#f-github').value = 'https://github.com/mine'; $('#f-github').dispatchEvent(new w.Event('input'));
    await sleep(600);
    check('Autosave works', local.data().profile?.phone === '555-0100' && /saved/.test($('#saveState').textContent));
    // upload a text resume -> AI fill
    const file = new w.File(['Ulugbek Rivera\nulug@example.edu\nExperience: Acme Intern 2025\nSkills: TypeScript'], 'resume.txt', { type: 'text/plain' });
    await w.handleResume(file);
    await sleep(150);
    const p = local.data().profile;
    check('Resume stored with text and file data', p.resume?.name === 'resume.txt' && p.resume.text.includes('Acme Intern') && p.resume.dataUrl.startsWith('data:text/plain'));
    check('AI fill: empty fields filled from resume', p.fullName === 'Ulugbek Rivera' && p.experience.startsWith('Acme') && $('#f-fullName').value === 'Ulugbek Rivera');
    check("AI fill: doesn't overwrite what you typed", p.github === 'https://github.com/mine', p.github);
    check('AI fill status message', /Filled \d+ fields from your resume, kept 1/.test($('#fillStatus').textContent), $('#fillStatus').textContent);
    check('AI fill uses JSON-only system prompt, no profile leak', /only valid JSON/.test(modelReq.system) && !/About the user/.test(modelReq.system));
    check('Onboarding steps all done', [...w.document.querySelectorAll('#onboardSteps li')].every(li => li.classList.contains('done')));
    // reject bad resume type
    await w.handleResume(new w.File(['x'], 'photo.png', { type: 'image/png' }));
    check('Rejects unsupported resume type', /PDF, Word/.test($('#fillStatus').textContent));
    // profile in chat
    w.profileToPrompt;
    const prompt = w.profileToPrompt(p, { includeResume: true });
    check('Profile prompt: filled fields only, resume included on request', /Full name: Ulugbek Rivera/.test(prompt) && !/Pronouns/.test(prompt) && /Resume text/.test(prompt) && /Gender: Decline to self-identify/.test(prompt));
    // applications table
    await local.set({ applications: [{ id: 'a1', date: new Date().toISOString(), company: 'Acme', role: 'Intern', status: 'submitted', url: 'https://x.com' }] });
    await w.renderApps();
    check('Applications table lists entries with links', $('#appsTable a')?.textContent === 'Intern' && $('#appsTable .status').textContent === 'submitted');
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
