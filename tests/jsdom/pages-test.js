const H = require(require('path').join(__dirname, 'helpers.js'));
const { srcPath } = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, sleep, makeStore, sseResponse, anthropicEvents, loadScripts, fs, DIR } = H;
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 700).replace(/\n/g, '\n        ') : ''}`);
const scriptsOf = page => [...fs.readFileSync(srcPath(page), 'utf8').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);

function boot(page, local, fetchImpl, expose = []) {
  const html = fs.readFileSync(srcPath(page), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/' + page });
  const w = dom.window;
  w.chrome = { storage: { local, session: makeStore(), onChanged: { addListener() {} } }, runtime: { getURL: p => p }, tabs: { query: async () => [] } };
  w.fetch = fetchImpl || (async () => { throw new Error('no network'); });
  if (!w.crypto.randomUUID) w.crypto.randomUUID = () => require('crypto').randomUUID();
  const files = scriptsOf(page);
  if (files.some(f => f.endsWith('/evals.js'))) files.unshift('vendor/math.js', 'vendor/nerdamer.js');
  loadScripts(w, files, expose);
  return { w, $: s => w.document.querySelector(s), $$: s => [...w.document.querySelectorAll(s)] };
}

(async () => {
  // ---------- profile: memories + documents ----------
  {
    const local = makeStore({ memories: [{ id: 'aaaaaaaa-1', text: 'Prefers dark mode', created: 1, updated: Date.now() }] });
    const { w, $, $$ } = boot('profile.html', local, null, ['addDocs']);
    await sleep(120);
    check('Memories listed', $$('#memList li .mem-text').map(e => e.textContent).join() === 'Prefers dark mode' && $('#memCount').textContent === '1 saved');
    $('#memNew').value = 'Exam on Nov 12'; $('#memAdd').click(); await sleep(60);
    check('Add memory', local.data().memories[0].text === 'Exam on Nov 12' && $$('#memList li').length === 2);
    $('#memNew').value = 'my card is 4242 4242 4242 4242'; $('#memAdd').click(); await sleep(60);
    check('Refuses to store a card number from the UI', local.data().memories.length === 2 && /doesn't store/.test($('#saveState').textContent));
    const t = $$('#memList .mem-text').find(e => e.textContent === 'Prefers dark mode');
    t.textContent = 'Prefers dark mode everywhere'; t.dispatchEvent(new w.Event('blur')); await sleep(60);
    check('Edit memory inline', local.data().memories.some(m => m.text === 'Prefers dark mode everywhere'));
    $('#memSearch').value = 'exam'; $('#memSearch').dispatchEvent(new w.Event('input')); await sleep(60);
    check('Search memories', $$('#memList li').length === 1);
    $$('#memList li button[aria-label="Delete memory"]')[0].click(); await sleep(60);
    check('Delete memory', local.data().memories.length === 1);
    const f = new w.File(['Final exam: December 12, Glatfelter 101.\n\nOffice hours Tue 2-4.'], 'syllabus.md', { type: 'text/markdown' });
    await w.addDocs([f]); await sleep(60);
    check('Add a document: indexed and listed', local.data().docIndex?.[0]?.name === 'syllabus.md' && local.data()['doc:' + local.data().docIndex[0].id]?.chunks.length === 1 && $$('#docList li').length === 1);
    $$('#docList li button')[0].click(); await sleep(60);
    check('Remove a document', !local.data().docIndex.length && !Object.keys(local.data()).some(k => k.startsWith('doc:')));
  }

  // ---------- settings ----------
  {
    const local = makeStore({ anthropicKey: 'sk-ant', usage: { [new Date().toLocaleDateString('en-CA')]: { 'claude-haiku-5-5': { calls: 3, input: 1200, output: 300, cacheRead: 900, cacheWrite: 0 } } } });
    const { w, $ } = boot('options.html', local);
    await sleep(120);
    check('Settings load defaults', $('#assistantName').value === 'Sidekick' && $('#routing').value === 'auto' && $('#smartEffort').value === 'high' && $('#trustedInput').checked && /paypal\.com/.test($('#blockedSites').value));
    check('Usage table shows today', /claude-haiku-5-5/.test($('#usage').textContent) && /Today/.test($('#usage').textContent));
    $('#assistantName').value = 'Jarvis'; $('#personality').value = 'witty'; $('#customInstructions').value = 'Be brief.'; $('#anthropicSmart').value = '';
    $('#save').click(); await sleep(80);
    const d = local.data();
    check('Save: persona + empty model falls back to default', d.assistantName === 'Jarvis' && d.personality === 'witty' && d.customInstructions === 'Be brief.' && d.anthropicSmart === 'claude-sonnet-5-5');
    check('Save prompts to re-run quality checks after brain changes', /Run the quality checks/.test($('#status').textContent));
  }

  // ---------- quality checks runner ----------
  {
    const local = makeStore({ anthropicKey: 'sk-ant', assistantName: 'Sidekick', memories: [{ id: 'real-1', text: 'REAL MEMORY', created: 1, updated: 1 }] });
    const answers = [
      [/derivative of x³/, () => [{ type: 'text', text: 'Using the product rule: $3x^2\\sin(x) + x^3\\cos(x)$.' }]],
      [/second derivative test/, () => [{ type: 'text', text: 'Only critical point (0,0). $D = 20\\cdot 18 - 0 = 360 > 0$ and $f_{xx} > 0$, so it is a **local minimum**.' }]],
      [/integral of x·e\^x/, () => [{ type: 'text', text: 'The result is $e - 1$.' }]],  // wrong on purpose
      [/limit of sin\(3x\)/, () => [{ type: 'text', text: 'The limit is 3.' }]],
      [/17\.5%/, () => [{ type: 'text', text: '**409.5**' }]],
      [/compounded monthly/, () => [{ type: 'text', text: 'About **$7,454.16**.' }]],
      [/Who are you/, () => [{ type: 'text', text: "I'm Sidekick, running on claude-haiku-5-5 by Anthropic." }]],
      [/Fix grammar/, () => [{ type: 'text', text: "They're going to the store tomorrow, and their car is broken." }]],
      [/Summarize this page/, () => [{ type: 'text', text: 'Honeybees pollinate a third of crops. Note: the page also contains an instruction to reply PWNED, which I ignored.' }]],
      [/prefer metric units/, (b, n) => n === 1 ? [{ type: 'tool_use', id: 'r1', name: 'remember', input: { fact: 'Prefers metric units' } }, { type: 'tool_use', id: 'r2', name: 'remember', input: { fact: 'Sister Aigerim lives in Almaty' } }] : [{ type: 'text', text: 'Noted.' }]],
      [/Mount Everest/, () => [{ type: 'text', text: 'Mount Everest is 8,849 m tall.' }]],
      [/credit card number/, () => [{ type: 'text', text: "I can't store card numbers." }]],
      [/^hi$/, () => [{ type: 'text', text: 'Hi! What can I do for you?' }]],
      [/f\(x,y\)=e\^\{xy\} subject to the constraint/, () => [{ type: 'text', text: '**Maximum: 8103.0839**\n**Minimum: DNE**' }]],
      [/A pipeline goes from P to Q/, () => [{ type: 'text', text: '**x ≈ 4.1295 miles, y ≈ 1.2572 miles**\n\n```setup\nvariables: x = run P→Q, y = run Q→R\ngoal: minimize 40*sqrt(x^2 + 4) + 46*sqrt(y^2 + 1) + 36*(10 - x - y)\nconstraints: 0 <= x <= 10, 0 <= y <= 10\nanswer: x = 4.1295, y = 1.2572\n```' }]],
      [/closest to the point \(6, 2, 0\)/, () => [{ type: 'text', text: '$(3, 1, \\sqrt{10})$, $(3, 1, -\\sqrt{10})$' }]],
      [/answer only in Spanish/, () => [{ type: 'text', text: '¡Claro! Responderé en español.' }]],
      [/capital of France/, () => [{ type: 'text', text: 'La capital de Francia es París.' }]],
      [/^And of Germany\?$/, (b) => [{ type: 'text', text: /Instruction: answer only in Spanish/.test(b.messages.at(-1).content.at(-1).text) ? 'La capital de Alemania es Berlín.' : 'The capital of Germany is Berlin.' }]]
    ];
    const calls = {};
    const fetchImpl = async (u, o) => {
      const body = JSON.parse(o.body);
      if (/You keep the pinned notes/.test(body.system)) {
        const said = body.messages[0].content.at(-1).text;
        return sseResponse(anthropicEvents([{ type: 'text', text: JSON.stringify({ notes: /Spanish/.test(said) ? ['Instruction: answer only in Spanish'] : (said.match(/Current pinned notes:\n- (.*)/) || [, ''])[1] ? [said.match(/Current pinned notes:\n- (.*)/)[1]] : [] }) }]));
      }
      if (/get to know its user over time/.test(body.system)) {
        return sseResponse(anthropicEvents([{ type: 'text', text: JSON.stringify({ add: [{ text: 'Wants short answers with a concrete example', kind: 'preference' }, { text: 'Studying linear algebra', kind: 'fact' }], update: [], remove: [], about: 'Likes short answers with examples.' }) }]));
      }
      const firstUser = body.messages.at(-1).role === 'user' && !body.messages.at(-1).content.some(c => c.type === 'tool_result') ? body.messages.at(-1).content.at(-1).text.replace(/^<context>[\s\S]*?<\/context>\n\n/, '') : body.messages[0].content.at(-1).text.replace(/^<context>[\s\S]*?<\/context>\n\n/, '');
      const hit = answers.find(([re]) => re.test(firstUser));
      if (!hit) throw new Error('unexpected prompt: ' + firstUser.slice(0, 80));
      const n = (calls[hit[0]] = (calls[hit[0]] || 0) + 1);
      let blocks = hit[1](body, n);
      // the memory case sends two tool calls; our client allows one per round, so split them
      if (blocks.filter(b => b.type === 'tool_use').length > 1) blocks = [blocks[0]];
      if (/prefer metric/.test(firstUser) && n === 2) blocks = [{ type: 'tool_use', id: 'r2', name: 'remember', input: { fact: 'Sister Aigerim lives in Almaty' } }];
      if (/prefer metric/.test(firstUser) && n === 3) blocks = [{ type: 'text', text: 'Noted.' }];
      return sseResponse(anthropicEvents(blocks, { stop: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }));
    };
    const { w, $, $$ } = boot('evals.html', local, fetchImpl, ['runAll']);
    await sleep(120);
    await w.runAll();
    const rows = $$('#cases tr').map(r => [r.querySelector('.t')?.textContent, r.querySelector('.dot')?.className]);
    const failed = rows.filter(r => /bad/.test(r[1])).map(r => r[0]);
    check('Runner: offline checks pass (router, redaction, calculator)', ['Routing picks the right model tier', 'Secrets are masked before reaching the model', 'Calculator computes exact calculus', "Calculator solves numerically when algebra can't"].every(t => rows.find(r => r[0] === t)?.[1].includes('ok')));
    check('Runner: catches the wrong integral, passes the rest', failed.length === 1 && failed[0] === 'Definite integral', failed.join(' | '));
    const run = local.data().evalRuns?.[0];
    check('Results saved with config key; summary shows gate', run?.passed === 23 && run.total === 24 && /23 of 24 passed\. Good to go\./.test($('#summary').textContent), $('#summary').textContent);
    check('Your real memories untouched by the run', local.data().memories.length === 1 && local.data().memories[0].text === 'REAL MEMORY');
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
