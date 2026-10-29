const { JSDOM } = require('jsdom');
const fs = require('fs'); const dir = require('path').join(__dirname, '..', 'extension') + '/';
const html = fs.readFileSync(dir+'sidepanel.html','utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
let store = { openaiKey: 'k', openaiModel: 'gpt-4o-mini', reasoning: 'high' };
const sent = [];
w.chrome = { storage: { local: { get: async d => ({ ...(Array.isArray(d) ? {} : d), ...store }), set: async o => Object.assign(store, o), remove: async () => {} }, session: { get: async () => ({}), remove: async () => {} }, onChanged: { addListener() {} } },
  tabs: { query: async () => [{ id: 1, windowId: 1, url: 'https://x.com' }] }, runtime: {} };
w.ResizeObserver = class { observe() {} };
w.fetch = async (url, o) => { sent.push(JSON.parse(o.body)); return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n`)); c.close(); } }), { status: 200 }); };
require(require('path').join(__dirname, 'helpers.js')).loadScripts(w, ['vendor/marked.js','vendor/purify.min.js','vendor/katex.min.js','vendor/highlight.min.js','vendor/math.js','vendor/nerdamer.js','ai.js','guard.js','profile-core.js','memory.js','skills.js','docs.js','web.js','screen.js','calc.js','page-agent.js','cdp.js','adapters.js','agent.js','session.js','brain.js','sidepanel.js'], ['renderMarkdown','autoScroll']);
const el = w.document.createElement('div');
const r = t => { w.renderMarkdown(el, t); return el; };
const cases = [
  ['inline \\( \\)', String.raw`The function \( f(x, y) = 4x^2y^2 + 10x^2 + 9y^2 \) has one critical point.`],
  ['display $$', "So\n\n$$D = f_{xx} f_{yy} - (f_{xy})^2 = 20 \\cdot 18 - 0 = 360$$\n\nwhich is positive."],
  ['display \\[ \\]', String.raw`\[ \frac{\partial f}{\partial x} = 8xy^2 + 20x \]`],
  ['inline $', "Since $f_{xx} = 20 > 0$, it's a **local minimum**."],
  ['currency left alone', "It costs $5 and $10 per month."],
  ['code left alone', "Use `$x$` literally:\n\n```py\nprice = '$5 and $6'\n```"],
  ['math in table', "| Point | $D$ |\n|---|---|\n| (0,0) | $360$ |"],
];
for (const [name, t] of cases) {
  r(t);
  const n = el.querySelectorAll('.katex').length, d = el.querySelectorAll('.math-display').length;
  console.log(name.padEnd(20), `katex=${n} display=${d}`, '|', el.textContent.replace(/\s+/g,' ').slice(0, 70));
}
r(String.raw`\( x_{1} \) and <img src=x onerror=alert(1)> \( \href{javascript:alert(1)}{click} \)`);
console.log('xss in math blocked:', !el.innerHTML.includes('onerror') && !el.innerHTML.includes('javascript:'));
(async () => {
  w.document.getElementById('input').value = 'hi';
  w.document.getElementById('input').dispatchEvent(new w.Event('input'));
  w.document.getElementById('send').click(); await new Promise(r => setTimeout(r, 300));
  console.log('old gpt-4o-mini migrated to:', sent[0].model, '| reasoning_effort sent:', sent[0].reasoning_effort);
  console.log('prompt has accuracy + LaTeX rules:', sent[0].messages[0].content.includes('Check the answer before stating it') && sent[0].messages[0].content.includes('$$...$$'));
  process.exit(0);
})();
