const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, sleep, makeStore, sseResponse, anthropicEvents, loadScripts, fs, DIR, PANEL_SCRIPTS } = H;
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 700).replace(/\n/g, '\n        ') : ''}`);
const SCRIPTS = PANEL_SCRIPTS;

function kindOf(body) {
  if (/You keep the pinned notes/.test(body.system)) return 'notes';
  if (/get to know its user over time/.test(body.system)) return 'reflect';
  return 'chat';
}
const lastUserText = body => { const m = body.messages.at(-1); return (m.content || []).filter(c => c.type === 'text').map(c => c.text).join(''); };

async function bootPanel(local, session, responder) {
  const html = fs.readFileSync(DIR + 'sidepanel.html', 'utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/sidepanel.html' });
  const w = dom.window; H.basicDom(w);
  const opened = [];
  w.chrome = {
    storage: { local, session, onChanged: { addListener() {} } },
    tabs: { query: async () => [{ id: 1, url: 'https://example.com', title: 'Example' }], create: async o => opened.push(o.url) },
    runtime: { getURL: p => 'chrome-extension://abc/' + p }
  };
  const reqs = [];
  w.fetch = async (u, o) => { const body = JSON.parse(o.body); const kind = kindOf(body); reqs.push({ kind, body, t: Date.now() }); return responder(kind, body, reqs); };
  loadScripts(w, SCRIPTS, ['openChat']);
  await sleep(120);
  const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
  const ask = async text => {
    for (let i = 0; i < 200 && $('#send').classList.contains('stop'); i++) await sleep(20);
    const before = $$('.msg.ai .actions').length;
    $('#input').value = text; $('#input').dispatchEvent(new w.Event('input')); $('#send').click();
    for (let i = 0; i < 300 && $$('.msg.ai .actions').length <= before; i++) await sleep(20);
    for (let i = 0; i < 200 && $('#send').classList.contains('stop'); i++) await sleep(20);
  };
  return { w, $, $$, ask, reqs, opened };
}

const text = t => sseResponse(anthropicEvents([{ type: 'text', text: t }]));

(async () => {
  // ---------- 1. one chat: pinned notes keep an instruction across turns and model switches ----------
  const local = makeStore({ anthropicKey: 'k', profile: { fullName: 'Ulugbek Rivera' } });
  const session = makeStore();
  let notesCalls = 0;
  const p = await bootPanel(local, session, async (kind, body) => {
    if (kind === 'notes') {
      notesCalls++;
      await sleep(300); // slow on purpose: the next message must wait for it
      const prev = (lastUserText(body).match(/Current pinned notes:\n([\s\S]*?)\n\nLatest exchange/) || [])[1] || '';
      const notes = prev.includes('(none yet)') ? [] : prev.split('\n').map(l => l.replace(/^- /, '')).filter(Boolean);
      const said = (lastUserText(body).match(/<user_message>([\s\S]*?)<\/user_message>/) || [])[1] || '';
      if (/answer only in Russian/.test(said)) notes.push('Instruction: answer only in Russian');
      if (/eigen/i.test(said)) notes.push('Studying eigenvalues for Linear Algebra');
      return text(JSON.stringify({ notes }));
    }
    if (kind === 'reflect') return text('```json\n' + JSON.stringify({ add: [{ text: 'Prefers answers in Russian', kind: 'preference' }, { text: 'Card 4111 1111 1111 1111', kind: 'fact' }], update: [], remove: [], about: 'Ulugbek is a CS student who wants short, direct answers in Russian.' }) + '\n```');
    return text('Ответ.');
  });
  const { $, $$, ask, reqs, w } = p;
  await ask('From now on answer only in Russian.');
  await ask('What are eigenvalues?');
  const chat2 = reqs.filter(r => r.kind === 'chat')[1];
  const notes2 = reqs.filter(r => r.kind === 'notes')[0];
  check('Next message waited for the notes update', chat2.t >= notes2.t + 280, `${chat2.t - notes2.t} ms`);
  check('Turn 2 carries the pinned instruction', /Pinned notes for this chat \(keep following these\):\n- Instruction: answer only in Russian/.test(lastUserText(chat2.body)));
  check('Full history still sent', chat2.body.messages.length === 3);
  $('#modelBadge').click(); await sleep(30); $('#modelBadge').click(); await sleep(30); // Auto → Fast → Smart
  await ask('and the determinant?');
  const chat3 = reqs.filter(r => r.kind === 'chat')[2];
  check('After switching to the smart model, the instruction is still pinned', chat3.body.model === 'claude-sonnet-5-5' && /- Instruction: answer only in Russian\n- Studying eigenvalues/.test(lastUserText(chat3.body)), lastUserText(chat3.body).slice(0, 400));
  check('System prompt tells every model to keep pinned instructions', /Treat every "Instruction:" as standing for the whole chat/.test(chat3.body.system));
  await ask('thanks');
  await sleep(400);
  check('Small talk doesn\'t trigger a notes update', notesCalls === 3, `${notesCalls} notes calls`);
  check('Pin button shows the notes', !$('#pinBtn').classList.contains('hidden') && $('.pin-count').textContent === '2');
  $('#pinBtn').click(); await sleep(20);
  check('Pinned popover lists them', $$('#pinList li span').map(e => e.textContent).join(' | ') === 'Instruction: answer only in Russian | Studying eigenvalues for Linear Algebra');
  const firstChatId = local.data().chatIndex[0].id;
  check('Notes saved with the chat', local.data()['chat:' + firstChatId].notes.length === 2);

  // ---------- 2. New chat: forget the session, keep what matters ----------
  $('#clear').click();
  for (let i = 0; i < 100 && !reqs.some(r => r.kind === 'reflect'); i++) await sleep(20);
  await sleep(150);
  const refl = reqs.find(r => r.kind === 'reflect');
  const rt = lastUserText(refl.body);
  check('Ending the chat triggers a review with the transcript and notes', /USER: From now on answer only in Russian\./.test(rt) && /- Instruction: answer only in Russian/.test(rt) && refl.body.model === 'claude-sonnet-5-5');
  const mems = local.data().memories || [];
  check('Essentials saved as a preference; secrets rejected', mems.length === 1 && mems[0].text === 'Prefers answers in Russian' && mems[0].kind === 'preference' && mems[0].source === 'learned');
  check('"How Sidekick sees you" summary saved', /CS student who wants short, direct answers in Russian/.test(local.data().userModel?.text));
  check('You get told what was learned, with a Review link', $('#toast').classList.contains('show') && /Learned 1 thing about you: “Prefers answers in Russian”/.test($('#toast').textContent));
  $('#toast button').click(); await sleep(20);
  check('Review opens your memories', p.opened.at(-1)?.endsWith('profile.html#sec-memories'));
  check('Chat marked as reviewed (not reviewed twice)', local.data()['chat:' + firstChatId].reflectedUpTo === 8);
  check('Pin button hidden in the new chat', $('#pinBtn').classList.contains('hidden'));

  await ask('What is a matrix?');
  const fresh = reqs.filter(r => r.kind === 'chat').at(-1);
  check('New chat: no old messages, no old pinned notes', fresh.body.messages.length === 1 && !/Pinned notes/.test(lastUserText(fresh.body)) && !/eigenvalues/i.test(lastUserText(fresh.body)));
  check('New chat: learned preference + summary in the system prompt', /preferences and habits \(learned from past chats; always apply\)\n- Prefers answers in Russian/.test(fresh.body.system) && /## How Ulugbek likes to work with you\nUlugbek is a CS student/.test(fresh.body.system));

  // ---------- 3. Reopening the old chat restores its notes ----------
  await w.openChat(firstChatId); await sleep(150);
  check('Reopened chat brings its pinned notes back', $('.pin-count').textContent === '2' && !$('#pinBtn').classList.contains('hidden'));
  const reflectCountBefore = reqs.filter(r => r.kind === 'reflect').length;
  check('Switching chats reviews the chat you left', reflectCountBefore === 2 || reflectCountBefore === 1);

  // ---------- 4. Chats left open when Chrome closed get reviewed on next start ----------
  {
    const old = Date.now() - 2 * 3600e3;
    const l2 = makeStore({ anthropicKey: 'k', chatIndex: [{ id: 'old1', title: 'x', updatedAt: old }], 'chat:old1': { id: 'old1', title: 'x', createdAt: old, updatedAt: old, notes: [], messages: [{ role: 'user', text: 'I am applying for summer internships in NYC', display: { prompt: 'I am applying for summer internships in NYC' } }, { role: 'assistant', text: 'Great.' }] } });
    const p2 = await bootPanel(l2, makeStore(), async kind => kind === 'reflect' ? text(JSON.stringify({ add: [{ text: 'Applying for summer internships in NYC', kind: 'goal' }], update: [], remove: [], about: null })) : text('ok'));
    for (let i = 0; i < 150 && !(l2.data().memories || []).length; i++) await sleep(20);
    check('Startup reviews chats that ended without a review (quietly)', l2.data().memories?.[0]?.kind === 'goal' && !p2.$('#toast').classList.contains('show'));
  }

  // ---------- 5. Learning off ----------
  {
    const l3 = makeStore({ anthropicKey: 'k', memoryAuto: false });
    const p3 = await bootPanel(l3, makeStore(), async kind => kind === 'notes' ? text('{"notes":["Instruction: be brief"]}') : text('ok'));
    await p3.ask('Please be brief in this chat, I am in a hurry.');
    await sleep(100);
    p3.$('#clear').click(); await sleep(300);
    check('Learning off: notes still work in-chat, but nothing is reviewed or saved', !p3.reqs.some(r => r.kind === 'reflect') && p3.reqs.some(r => r.kind === 'notes') && !(l3.data().memories || []).length);
  }

  // ---------- 6. Reflection logic (store-level) ----------
  {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const w4 = dom.window;
    w4.chrome = { storage: { local: makeStore({ anthropicKey: 'k' }) } };
    w4.fetch = async () => text(JSON.stringify({
      add: [1, 2, 3, 4, 5, 6, 7].map(i => ({ text: `Fact ${i}`, kind: 'fact' })),
      update: [{ id: 'aaaabbbb', text: 'Prefers very short answers', kind: 'preference' }],
      remove: ['ccccdddd', 'zzzz'],
      about: 'Likes brevity.'
    }));
    loadScripts(w4, ['ai.js', 'guard.js', 'profile-core.js', 'memory.js', 'skills.js', 'session.js'], ['reflectOnChat']);
    const items = [{ id: 'aaaabbbb-1', text: 'Prefers short answers', kind: 'preference' }, { id: 'ccccdddd-2', text: 'Lives in Ohio', kind: 'fact' }];
    let about = '';
    const store = {
      list: async () => items,
      add: async (t, k) => items.push({ id: Math.random().toString(16).slice(2), text: t, kind: k }),
      update: async (id, t, k) => Object.assign(items.find(x => x.id === id), { text: t, kind: k }),
      remove: async id => { const i = items.findIndex(x => x.id === id); return i > -1 ? items.splice(i, 1)[0] : null; },
      getAbout: async () => about, setAbout: async t => { about = t; }
    };
    const r = await w4.reflectOnChat({ messages: [{ role: 'user', text: 'I moved to Pennsylvania, and keep answers very short' }, { role: 'assistant', text: 'ok' }] }, { store });
    check('Review applies updates/removals by short id, caps additions at 5', r.added.length === 5 && items.find(x => x.id === 'aaaabbbb-1').text === 'Prefers very short answers' && !items.some(x => x.text === 'Lives in Ohio') && about === 'Likes brevity.');
    const r2 = await w4.reflectOnChat({ messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }] }, { store });
    const r3 = await w4.reflectOnChat({ reflectedUpTo: 2, messages: [{ role: 'user', text: 'I moved to Pennsylvania and want short answers' }, { role: 'assistant', text: 'ok' }] }, { store });
    check('Nothing new to learn → no review call', r2 === null && r3 === null);
  }

  // ---------- 7. Very long chats stay within the context window ----------
  {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const w5 = dom.window;
    let body;
    w5.chrome = { storage: { local: makeStore({ anthropicKey: 'k' }) } };
    w5.fetch = async (u, o) => { body = JSON.parse(o.body); return text('ok'); };
    loadScripts(w5, ['vendor/math.js', 'vendor/nerdamer.js', 'ai.js', 'guard.js', 'profile-core.js', 'memory.js', 'skills.js', 'docs.js', 'web.js', 'screen.js', 'calc.js', 'session.js', 'brain.js'], ['runTurn']);
    const history = [];
    for (let i = 0; i < 60; i++) history.push({ role: i % 2 ? 'assistant' : 'user', text: `message ${i} ` + 'x'.repeat(3000) });
    await w5.runTurn(history, { text: 'next question' }, { hasTab: false, sessionNotes: ['Instruction: be brief'] });
    const chars = JSON.stringify(body.messages).length;
    check('Long chat trimmed: recent messages kept, notes still pinned, starts with you', body.messages.length <= 43 && chars < 140000 && body.messages[0].role === 'user' && /omitted; the pinned notes cover/.test(JSON.stringify(body.messages[0])) && /message 59/.test(JSON.stringify(body.messages.at(-2))) && /- Instruction: be brief/.test(JSON.stringify(body.messages.at(-1))), `${body.messages.length} msgs, ${chars} chars`);
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
