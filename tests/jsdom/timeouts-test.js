// v0.9.5: every outside await in chat has a time limit and obeys Stop (rule 4), not just the
// agent's. A page showing alert() or "Leave site?" used to hang a chat turn forever, and a slow
// site or search engine hung read_url / web_search with no way to stop it.
const { JSDOM, sleep, makeStore, sseResponse, anthropicEvents, loadScripts } = require(require('path').join(__dirname, 'helpers.js'));
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 600).replace(/\n/g, '\n        ') : ''}`);

const FILES = ['ai.js', 'guard.js', 'profile-core.js', 'memory.js', 'skills.js', 'docs.js', 'web.js', 'screen.js', 'calc.js', 'session.js', 'brain.js'];
const never = () => new Promise(() => {});
// A network request that never answers, but stops when its signal fires (like real fetch).
const hang = o => new Promise((_, reject) => o?.signal?.addEventListener('abort', () => reject(o.signal.reason ?? new Error('aborted')), { once: true }));
// Resolves to 'hung' if p doesn't settle in time; otherwise { ok, value | error }.
const settle = (p, ms = 2500) => Promise.race([p.then(value => ({ ok: true, value }), error => ({ ok: false, error })), sleep(ms).then(() => 'hung')]);

function boot({ tabs = {}, scripting = {}, fetchImpl } = {}) {
  const w = new JSDOM('<!doctype html><head></head><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/x.html' }).window;
  w.SK_PAGE_MS = 200; w.SK_WEB_MS = 200;
  w.chrome = {
    storage: { local: makeStore({ anthropicKey: 'k', webSearch: false }), session: makeStore() },
    runtime: { getURL: p => p },
    tabs: { query: async () => [{ id: 1, windowId: 1, url: 'https://hw.example.edu/q', title: 'Q' }], get: async () => ({ id: 1, windowId: 1, url: 'https://hw.example.edu/q' }), ...tabs },
    scripting
  };
  w.fetch = fetchImpl || (async (u, o) => hang(o));
  if (!w.crypto.randomUUID) w.crypto.randomUUID = () => require('crypto').randomUUID();
  loadScripts(w, FILES, ['readPageText', 'readProblemText', 'readSelectionFromPage', 'captureScreen', 'runInPage', 'fetchUrlText', 'webSearchFallback', 'runTurn']);
  return w;
}

(async () => {
  // ---------- page reads in chat ----------
  {
    const w = boot({ scripting: { executeScript: never } });
    const r = await settle(w.readPageText());
    check('Reading a page that never answers (alert(), "Leave site?") gives up with a clear error', r !== 'hung' && !r.ok && r.error.name === 'PageTimeout' && /isn't responding/.test(r.error.message), r === 'hung' ? 'hung' : r.error?.message);
    const s = await settle(w.readSelectionFromPage());
    check('Same for reading the selection', s !== 'hung' && !s.ok && /isn't responding/.test(s.error.message));
    const p = await settle(w.readProblemText());
    check('Reading the problem on screen: says it couldn\'t read the page, instead of hanging', p !== 'hung' && p.ok && /can't read this page/.test(p.value.text) && /isn't responding/.test(p.value.text), JSON.stringify(p));
  }
  {
    const w = boot({ tabs: { captureVisibleTab: never } });
    const r = await settle(w.captureScreen());
    check('A screenshot Chrome never delivers gives up with an error', r !== 'hung' && !r.ok, r === 'hung' ? 'hung' : '');
  }
  {
    // Picking an area waits for you, however long that takes.
    const w = boot({ scripting: { executeScript: async () => { await sleep(500); return [{ result: { x: 1 } }]; } } });
    const r = await settle(w.runInPage(() => 0, [], 'captured', undefined, 0));
    check('Scripts that wait for you (pick an area) have no time limit', r !== 'hung' && r.ok && r.value.x === 1, JSON.stringify(r));
  }

  // ---------- read_url and web search ----------
  {
    const w = boot();
    const r = await settle(w.fetchUrlText('https://slow.example.com/page'));
    check('read_url: a site that never answers → "didn\'t answer within …"', r !== 'hung' && !r.ok && /didn't answer within/.test(r.error.message), r === 'hung' ? 'hung' : r.error?.message);
    const ctl = new w.AbortController();
    const p = settle(w.fetchUrlText('https://slow.example.com/page', { signal: ctl.signal }), 150);
    ctl.abort();
    const s = await p;
    check('read_url: Stop stops it right away (an AbortError, not an error message)', s !== 'hung' && !s.ok && s.error.name === 'AbortError', s === 'hung' ? 'hung' : s.error?.name);
    const q = await settle(w.webSearchFallback('gettysburg weather'));
    check('Web search: engines that never answer → a clear error', q !== 'hung' && !q.ok && /didn't answer within/.test(q.error.message), q === 'hung' ? 'hung' : q.error?.message);
    const ctl2 = new w.AbortController();
    const p2 = settle(w.webSearchFallback('x', 6, { signal: ctl2.signal }), 150);
    ctl2.abort();
    const q2 = await p2;
    check('Web search: Stop stops it', q2 !== 'hung' && !q2.ok && q2.error.name === 'AbortError', q2 === 'hung' ? 'hung' : q2.error?.name);
  }

  // ---------- a chat turn ----------
  {
    const reqs = [];
    const w = boot({ fetchImpl: async (u, o) => {
      if (!/api\.anthropic\.com/.test(u)) return hang(o);
      reqs.push(JSON.parse(o.body));
      return reqs.length === 1
        ? sseResponse(anthropicEvents([{ type: 'tool_use', id: 't1', name: 'read_url', input: { url: 'https://slow.example.com/a' } }], { stop: 'tool_use' }))
        : sseResponse(anthropicEvents([{ type: 'text', text: 'That site is too slow right now.' }]));
    } });
    const r = await settle(w.runTurn([], { text: 'what does https://slow.example.com/a say?' }, { hasTab: false, signal: new w.AbortController().signal }));
    const toolText = JSON.stringify(reqs[1]?.messages || '');
    check('Chat: a slow read_url ends as a tool error the model can explain, and the turn finishes', r !== 'hung' && r.ok && /didn't answer within/.test(toolText) && r.value.text === 'That site is too slow right now.', r === 'hung' ? 'hung' : r.error?.message || toolText.slice(0, 300));

    reqs.length = 0;
    w.SK_WEB_MS = 60000;
    const ctl = new w.AbortController();
    const p = settle(w.runTurn([], { text: 'what does https://slow.example.com/a say?' }, { hasTab: false, signal: ctl.signal }), 1500);
    await sleep(150);
    ctl.abort();
    const s = await p;
    check('Chat: Stop during read_url ends the turn', s !== 'hung' && !s.ok && s.error.name === 'AbortError', s === 'hung' ? 'hung' : s.error?.name);
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); console.log(results.join('\n')); process.exit(1); });
