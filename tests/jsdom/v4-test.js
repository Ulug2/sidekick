const { srcPath } = require(require('path').join(__dirname, 'helpers.js'));
const __notesReq = body => /You keep the pinned notes|get to know its user over time/.test((body && (body.system || body.instructions)) || '');
const __notesRes = (body, H2) => /get to know/.test(body.system || body.instructions || '') ? (body.input ? H2.sseResponse(H2.openaiEvents({ text: '{"add":[],"update":[],"remove":[],"about":null}' })) : H2.sseResponse(H2.anthropicEvents([{ type: 'text', text: '{"add":[],"update":[],"remove":[],"about":null}' }]))) : (body.input ? H2.sseResponse(H2.openaiEvents({ text: '{"notes":[]}' })) : H2.sseResponse(H2.anthropicEvents([{ type: 'text', text: '{"notes":[]}' }])));
const { JSDOM } = require('jsdom');
const fs = require('fs'); const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);

function makeStore(init = {}) {
  let data = { ...init };
  return {
    data: () => data,
    get: async k => { if (k == null) return { ...data }; if (typeof k === 'string') return k in data ? { [k]: data[k] } : {}; if (Array.isArray(k)) return Object.fromEntries(k.filter(x => x in data).map(x => [x, data[x]])); const o = {}; for (const [kk, d] of Object.entries(k)) o[kk] = kk in data ? data[kk] : d; return o; },
    set: async o => { data = { ...data, ...JSON.parse(JSON.stringify(o)) }; },
    remove: async k => { for (const x of [].concat(k)) delete data[x]; }
  };
}

async function boot(local, session) {
  const html = fs.readFileSync(srcPath('sidepanel.html'),'utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/sidepanel.html' });
  const w = dom.window;
  const env = { sent: [], tabsCreated: [], scriptCalls: [], replyText: 'Here you go.\n\n```js\nconst a = 1; // note\n```' };
  w.chrome = {
    storage: { local, session, onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 1, windowId: 1, url: 'https://news.example.com/story' }],
      captureVisibleTab: async () => 'data:image/jpeg;base64,SHOT',
      create: async o => env.tabsCreated.push(o.url)
    },
    scripting: { executeScript: async ({ func }) => {
      const src = func.toString(); env.scriptCalls.push(src.slice(0, 30));
      if (src.includes('attachShadow')) return [{ result: { x: 10, y: 20, w: 100, h: 50, vw: 1000, vh: 800 } }];
      if (src.includes('innerText')) return [{ result: { title: 'Big News Story', url: 'https://news.example.com/story', text: 'Paragraph one of the article.', truncated: false } }];
      if (src.includes('getSelection')) return [{ result: 'teh selected sentnce' }];
      return [{ result: true }];
    } },
    runtime: { openOptionsPage() {}, getURL: p => 'chrome-extension://abc/' + p }
  };
  w.ResizeObserver = class { observe() {} };
  w.navigator.clipboard = { writeText: async t => (env.copied = t) };
  w.crypto.randomUUID ||= () => Math.random().toString(36).slice(2);
  // image stubs (jsdom has no canvas)
  w.createImageBitmap = async b => (b.type === 'image/jpeg' ? { width: 2000, height: 1600 } : { width: 400, height: 300 }); // screenshots are big, pasted PNGs small
  w.OffscreenCanvas = class { constructor(wd, h) { env.canvas = [wd, h]; } getContext() { return { drawImage: (...a) => (env.drawArgs = a) }; } async convertToBlob(o) { return new w.Blob(['x'], { type: o.type }); } };
  w.fetch = async (url, o) => {
    if (String(url).startsWith('data:')) return { blob: async () => new w.Blob(['img'], { type: 'image/jpeg' }) };
    if (o?.body && __notesReq(JSON.parse(o.body))) return __notesRes(JSON.parse(o.body), require(require('path').join(__dirname, 'helpers.js')));
    env.sent.push(JSON.parse(o.body));
    const chunks = require(require('path').join(__dirname, 'helpers.js')).openaiEvents({ text: env.replyText }).map(e => `data: ${JSON.stringify(e)}\n\n`);
    return new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); } }), { status: 200 });
  };
  // fake speech recognition
  w.webkitSpeechRecognition = class { constructor() { env.rec = this; } start() { env.recStarted = true; } stop() { this.onend?.(); } };
  require(require('path').join(__dirname, 'helpers.js')).loadScripts(w, ['vendor/marked.js','vendor/purify.min.js','vendor/katex.min.js','vendor/highlight.min.js','vendor/math.js','vendor/nerdamer.js','ai.js','guard.js','profile-core.js','memory.js','skills.js','docs.js','web.js','screen.js','calc.js','page-agent.js','cdp.js','adapters.js','agent.js','session.js','brain.js','sidepanel.js']);
  await sleep(80);
  return { w, env, $: s => w.document.querySelector(s), $$: s => [...w.document.querySelectorAll(s)] };
}

const typeAndSend = async (t, text) => { t.$('#input').value = text; t.$('#input').dispatchEvent(new t.w.Event('input')); t.$('#send').click(); await sleep(700); };

(async () => {
  const local = makeStore({ openaiKey: 'k' }), session = makeStore();
  let t = await boot(local, session);

  // page text via Summarize chip
  t.$('.chip[data-action="summarize"]').click(); await sleep(700);
  const s1 = t.env.sent[0].input.at(-1).content.map(c => c.text || '').join('');
  check('Summarize page attaches page text', typeof s1 === 'string' && s1.includes('Page content from "Big News Story"') && s1.includes('Paragraph one'));
  check('User message shows page tag', t.$$('.msg.user .tag')[0]?.textContent.includes('Big News Story'));
  check('Code block syntax highlighted', !!t.$('.msg.ai .code-block code.hljs .hljs-keyword') && !!t.$('.msg.ai .hljs-comment'));

  // saved history
  const idx = local.data().chatIndex;
  check('Chat saved to storage', idx?.length === 1 && local.data()['chat:' + idx[0].id]?.messages.length === 2, idx?.[0]?.title);

  // paste an image
  const png = new t.w.File(['pngbytes'], 'shot.png', { type: 'image/png' });
  const pasteEv = new t.w.Event('paste', { bubbles: true, cancelable: true });
  pasteEv.clipboardData = { files: [png] };
  t.$('#input').dispatchEvent(pasteEv); await sleep(50);
  check('Paste image adds thumbnail to tray', t.$$('#tray .att-image').length === 1 && pasteEv.defaultPrevented);

  // drop a text file and an unsupported pdf
  const txt = new t.w.File(['line one\nline two'], 'notes.md', { type: '' });
  const pdf = new t.w.File(['PK'], 'archive.zip', { type: 'application/zip' });
  const dropEv = new t.w.Event('drop', { bubbles: true, cancelable: true });
  dropEv.dataTransfer = { types: ['Files'], files: [txt, pdf] };
  t.w.document.dispatchEvent(dropEv); await sleep(50);
  check('Drop text file adds file chip', t.$$('#tray .att').some(a => a.textContent.includes('notes.md')));
  check('Unsupported file shows a clear error', t.$$('.msg.error').some(e => e.textContent.includes("archive.zip isn't supported yet") && e.textContent.includes('PDFs')));

  // region capture
  t.$('#regionBtn').click(); await sleep(80);
  check('Region capture crops at screenshot scale', JSON.stringify(t.env.canvas) === '[200,100]' && t.env.drawArgs?.slice(1, 5).join() === '20,40,200,100', `canvas ${t.env.canvas}`);
  check('Region image added to tray', t.$$('#tray .att-image').length === 2);

  // send with 2 images + file
  await typeAndSend(t, 'what is in these?');
  const last = t.env.sent.at(-1).input.at(-1);
  const parts = Array.isArray(last.content) ? last.content : [];
  check('Two images sent with correct types', parts.filter(p => p.type === 'input_image').length === 2 && parts.slice(1).every(p => p.image_url.startsWith('data:image/png')));
  check('File text included in prompt', parts[0]?.text.includes('File "notes.md"') && parts[0].text.includes('line two'));
  check('Tray cleared after sending', t.$('#tray').classList.contains('hidden'));

  // next turn: older images omitted
  await typeAndSend(t, 'thanks');
  const msgs = t.env.sent.at(-1).input;
  const withImgs = msgs.filter(m => Array.isArray(m.content) && m.content.some(c => c.type === 'input_image'));
  check('Follow-up keeps the latest images', withImgs.length === 1 && withImgs[0].content.filter(c => c.type === 'input_image').length === 2);

  // Anthropic path media types
  local.set({ provider: 'anthropic', anthropicKey: 'a', openaiKey: '' });
  const ant = []; const oldFetch = t.w.fetch;
  t.w.fetch = async (u, o) => { if (o?.body && __notesReq(JSON.parse(o.body))) return __notesRes(JSON.parse(o.body), require(require('path').join(__dirname, 'helpers.js'))); if (String(u).includes('anthropic')) { ant.push(JSON.parse(o.body)); return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n')); c.close(); } }), { status: 200 }); } return oldFetch(u, o); };
  const p2 = new t.w.Event('paste', { cancelable: true }); p2.clipboardData = { files: [new t.w.File(['x'], 'a.png', { type: 'image/png' })] };
  t.$('#input').dispatchEvent(p2); await sleep(30);
  await typeAndSend(t, 'claude look');
  const img = ant[0]?.messages.at(-1).content.find(c => c.type === 'image');
  check('Anthropic gets real media type (png, not forced jpeg)', img?.source.media_type === 'image/png');
  const antMsgs = ant[0].messages;
  check('Older images dropped once new ones arrive', antMsgs.filter(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image')).length === 1 && antMsgs.some(m => JSON.stringify(m.content).includes('[2 earlier images not shown]')));
  local.set({ provider: 'openai', anthropicKey: '', openaiKey: 'k' }); t.w.fetch = oldFetch;

  // voice
  t.$('#input').value = 'hello';
  t.$('#micBtn').click();
  t.env.rec.onresult({ results: [[{ transcript: 'world how' }], [{ transcript: ' are you' }]] });
  check('Dictation appends to typed text', t.$('#input').value === 'hello world how are you' && t.$('#micBtn').classList.contains('listening'));
  t.env.rec.onerror({ error: 'not-allowed' });
  check('Mic permission opens helper tab', t.env.tabsCreated[0]?.endsWith('mic.html') && !t.$('#micBtn').classList.contains('listening'));
  t.$('#input').value = '';

  // history drawer: new chat, list, reopen, delete
  t.$('#clear').click(); await sleep(20);
  check('New chat clears conversation', !!t.$('.empty'));
  await typeAndSend(t, 'second chat question');
  t.$('#historyBtn').click(); await sleep(60);
  const rows = t.$$('.chat-row .chat-open').map(b => b.textContent);
  check('Drawer lists both chats, newest first', rows.length === 2 && rows[0] === 'second chat question' && t.$$('.chat-group')[0]?.textContent === 'Today', rows.join(' | '));
  t.$('#chatSearch').value = 'summarize'; t.$('#chatSearch').dispatchEvent(new t.w.Event('input')); await sleep(30);
  check('Search filters chats', t.$$('.chat-row').length === 1);
  t.$('.chat-open').click(); await sleep(60);
  check('Reopening restores messages', t.$$('.msg.user').length === 4 && t.$$('.msg.ai').length === 4 && !t.$('#drawer').classList.contains('open'));
  check('Restored code is highlighted', !!t.$('.msg.ai .hljs-keyword'));

  // reload panel: always starts a new chat; the last one is in history
  const t2 = await boot(local, session);
  check('Reopening the panel starts a new chat (no old messages shown)', t2.$$('.msg.user').length === 0 && !!t2.$('.empty'));
  t2.$('#historyBtn').click(); await sleep(60);
  check('…and the previous chats are saved in history', t2.$$('.chat-row .chat-open').length === 2);
  t2.$('#historyBtn').click(); await sleep(50);
  t2.$$('.chat-del')[0].click(); await sleep(50);
  check('Delete removes chat', (await local.get('chatIndex')).chatIndex.length === 1);

  // earlier features still work
  t2.$('#clear').click();
  t2.$('.chip[data-action="rewrite"]').click(); await sleep(700);
  check('Rewrite still grabs selection + offers Replace', t2.$('.msg.user .quote')?.textContent === 'teh selected sentnce' && t2.$$('.msg.ai .act').some(b => /Replace/.test(b.title)));

  console.log(results.join('\n'));
  console.log(`\n${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
