// Shared test helpers: fake chrome.storage, fake streaming APIs, page loader.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const ROOT = require('path').join(__dirname, '..', '..');
const DIR = ROOT + '/src/';
// Where a file the suites knew by its old flat name lives now: pages, vendored libraries, the content script.
function srcPath(name) {
  if (name.startsWith('vendor/')) return `${ROOT}/public/${name}`;
  if (name.endsWith('.html')) return `${ROOT}/src/pages/${name}`;
  if (name === 'webmcp-capture.js') return `${ROOT}/src/content/${name}`;
  throw new Error(`srcPath: unknown file ${name}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeStore(init = {}) {
  let data = JSON.parse(JSON.stringify(init));
  const listeners = [];
  return {
    data: () => data,
    listeners,
    get: async k => {
      if (k == null) return JSON.parse(JSON.stringify(data));
      if (typeof k === 'string') return k in data ? { [k]: JSON.parse(JSON.stringify(data[k])) } : {};
      if (Array.isArray(k)) return Object.fromEntries(k.filter(x => x in data).map(x => [x, JSON.parse(JSON.stringify(data[x]))]));
      const o = {}; for (const [kk, d] of Object.entries(k)) o[kk] = kk in data ? JSON.parse(JSON.stringify(data[kk])) : d; return o;
    },
    set: async o => { data = { ...data, ...JSON.parse(JSON.stringify(o)) }; },
    remove: async k => { for (const x of [].concat(k)) delete data[x]; }
  };
}

const enc = new TextEncoder();
function sseResponse(events, { delay = 0 } = {}) {
  const chunks = events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  return new Response(new ReadableStream({
    async start(c) {
      for (const ch of chunks) {
        // split each event in two to exercise partial-line buffering
        const mid = Math.floor(ch.length / 2);
        c.enqueue(enc.encode(ch.slice(0, mid))); c.enqueue(enc.encode(ch.slice(mid)));
        if (delay) await sleep(delay);
      }
      c.close();
    }
  }), { status: 200 });
}

// Claude stream for a list of content blocks: {type:'text',text} | {type:'thinking',signature} |
// {type:'tool_use',id,name,input} | {type:'server_tool_use',id,name,input} | {type:'web_search_tool_result',...}
function anthropicEvents(blocks, { stop = 'end_turn', usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 } } = {}) {
  const ev = [{ type: 'message_start', message: { usage } }];
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      for (const piece of b.text.match(/[\s\S]{1,7}/g) || []) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: piece } });
      for (const c of b.citations || []) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'citations_delta', citation: c } });
    } else if (b.type === 'thinking') {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } });
      ev.push({ type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: '' } });
      ev.push({ type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: b.signature } });
    } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: b.type, id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      for (const piece of json.match(/[\s\S]{1,9}/g) || []) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: piece } });
    } else {
      ev.push({ type: 'content_block_start', index: i, content_block: b });
    }
    ev.push({ type: 'content_block_stop', index: i });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: usage.output_tokens } });
  ev.push({ type: 'message_stop' });
  return ev;
}

// OpenAI Responses API stream: optional reasoning item, text, one function call, web search, citations.
function openaiEvents({ text = '', toolCall = null, reasoning = true, search = null, citations = [], usage = { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 40 } } } = {}) {
  const ev = [{ type: 'response.created', response: { status: 'in_progress' } }];
  const output = [];
  const add = item => { const i = output.length; output.push(item); ev.push({ type: 'response.output_item.added', output_index: i, item: { ...item, ...(item.type === 'function_call' && { arguments: '' }) } }); return i; };
  if (reasoning) { const r = { type: 'reasoning', id: 'rs_' + Math.random().toString(36).slice(2, 7), summary: [], encrypted_content: 'ENC' }; const i = add(r); ev.push({ type: 'response.output_item.done', output_index: i, item: r }); }
  if (search) { const w = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: search } }; const i = add(w); ev.push({ type: 'response.output_item.done', output_index: i, item: w }); }
  if (text) {
    const msg = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: citations.map(c => ({ type: 'url_citation', ...c, start_index: 0, end_index: 1 })) }] };
    const i = add({ ...msg, content: [] });
    for (const piece of text.match(/[\s\S]{1,6}/g)) ev.push({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: i, content_index: 0, delta: piece });
    citations.forEach((c, k) => ev.push({ type: 'response.output_text.annotation.added', output_index: i, annotation_index: k, annotation: { type: 'url_citation', ...c } }));
    ev.push({ type: 'response.output_item.done', output_index: i, item: msg });
  }
  if (toolCall) {
    const fc = { type: 'function_call', id: 'fc_1', call_id: toolCall.id, name: toolCall.name, arguments: JSON.stringify(toolCall.args), status: 'completed' };
    const i = add(fc);
    for (const piece of fc.arguments.match(/[\s\S]{1,5}/g)) ev.push({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: i, delta: piece });
    ev.push({ type: 'response.output_item.done', output_index: i, item: fc });
  }
  ev.push({ type: 'response.completed', response: { status: 'completed', output, usage } });
  return ev;
}

const PANEL_SCRIPTS = ['vendor/marked.js', 'vendor/purify.min.js', 'vendor/katex.min.js', 'vendor/highlight.min.js', 'vendor/math.js', 'vendor/nerdamer.js',
  'ai.js', 'guard.js', 'profile-core.js', 'memory.js', 'skills.js', 'docs.js', 'web.js', 'screen.js', 'calc.js', 'page-agent.js', 'cdp.js', 'adapters.js', 'agent.js', 'session.js', 'brain.js', 'sidepanel.js'];

// The extension's code is ES modules; scripts/build-test.mjs bundles it into classic scripts in
// .test-build/ (npm test builds them first). loadScripts evaluates the vendor files listed, then
// the bundle for the page those files belong to, and exposes the names a test asks for.
const TEST_BUILD = ROOT + '/.test-build/';
const PAGE_BUNDLES = ['sidepanel', 'profile', 'evals', 'options', 'mic', 'runs', 'bench'];
const bundleCache = {};
function bundleFor(files) {
  const names = files.map(f => f.split('/').pop());
  const page = PAGE_BUNDLES.find(p => names.includes(`${p}.js`)) || 'lib';
  return (bundleCache[page] ||= fs.readFileSync(TEST_BUILD + page + '.js', 'utf8'));
}

// Script files a page loads, in order (vendor files, then its module entry).
function pageScripts(page) {
  return [...fs.readFileSync(srcPath(page), 'utf8').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);
}

// Same contract as when each file was a classic <script>: vendor files run as they are, every
// function declaration of our files is on window, and `expose` names are put on window.
function loadScripts(w, files, expose = []) {
  w.structuredClone ||= v => structuredClone(v);
  w.TextDecoder ||= TextDecoder; w.TextEncoder ||= TextEncoder;
  for (const f of files.filter(f => f.startsWith('vendor/'))) w.eval(fs.readFileSync(srcPath(f), 'utf8'));
  if (files.some(f => !f.startsWith('vendor/'))) w.eval(bundleFor(files));
  for (const name of expose) {
    if (!(name in (w.__sk || {}))) throw new w.ReferenceError(`${name} is not defined`);
    w[name] = w.__sk[name];
  }
}

function basicDom(w) {
  w.ResizeObserver = class { observe() {} };
  w.navigator.clipboard = { writeText: async t => (w.__copied = t) };
  w.Element.prototype.scrollIntoView = function () {};
}

// The agent's safety check (v0.9.3) asks the fast model about new sites and sharing details.
// Old suites that don't test it get "ok"; every check is recorded in global.__checks.
function checkerReply(body, verdict = 'ok') {
  if (!/You check one step of a browser agent/.test(body?.system || '')) return null;
  (global.__checks ||= []).push(body);
  return sseResponse(anthropicEvents([{ type: 'text', text: JSON.stringify({ verdict, reason: 'Test checker.' }) }]));
}

module.exports = { checkerReply, JSDOM, fs, DIR, sleep, makeStore, sseResponse, anthropicEvents, openaiEvents, PANEL_SCRIPTS, loadScripts, pageScripts, srcPath, basicDom };
