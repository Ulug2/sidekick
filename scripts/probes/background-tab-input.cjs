// Probe: does Chrome's debugger input work in a background tab? (2026-10-29: mouse clicks time out;
// insertText, keys and Page.captureScreenshot work.) Starts Playwright's Chromium without Playwright
// driving it (Playwright emulates focus on pages it controls, which hides the effect), loads dist/,
// and drives only the extension's options page over CDP. Run: npm run build && node scripts/probes/background-tab-input.cjs
const { chromium } = require('playwright');
const { spawn } = require('child_process'); const http = require('http'); const fs = require('fs');
const EXT = require('path').join(__dirname, '..', '..', 'dist');
const html = `<!doctype html><title>t</title><input id=i><button id=b style="position:absolute;left:20px;top:60px;width:80px;height:30px" onclick="document.title='clicked:'+event.isTrusted">B</button>`;
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(q.url === '/front' ? '<h1>your tab</h1>' : html); }).listen(0);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const port = srv.address().port;
  const user = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'sk-probe-'));
  const chrome = spawn(chromium.executablePath(), [`--user-data-dir=${user}`, '--remote-debugging-port=9333', '--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `http://127.0.0.1:${port}/front`], { stdio: 'ignore' });
  let targets = [];
  for (let i = 0; i < 50; i++) { await sleep(300); try { targets = await (await fetch('http://127.0.0.1:9333/json/list')).json(); if (targets.some(t => t.url.includes('chrome-extension://'))) break; } catch {} }
  const sw = targets.find(t => t.url.startsWith('chrome-extension://'));
  const id = sw.url.split('/')[2];
  // open the options page as a tab, then put "your tab" back in front
  const opt = await (await fetch(`http://127.0.0.1:9333/json/new?chrome-extension://${id}/options.html`, { method: 'PUT' })).json();
  await sleep(1500);
  const ws = new WebSocket(opt.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let n = 0; const pending = {}; ws.onmessage = e => { const m = JSON.parse(e.data); pending[m.id]?.(m); };
  const cdp = (method, params) => new Promise(r => { const i = ++n; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r; };
  const front = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find(t => t.url.endsWith('/front'));
  await fetch(`http://127.0.0.1:9333/json/activate/${front.id}`);
  await sleep(800);
  const out = await evaluate(`(async () => {
    const t = (p, ms = 4000) => Promise.race([p.then(() => 'ok', e => 'err ' + e.message.slice(0, 80)), new Promise(r => setTimeout(() => r('TIMEOUT'), ms))]);
    const [me] = await chrome.tabs.query({ url: location.href });
    const tab = await chrome.tabs.create({ url: 'http://127.0.0.1:${port}/form', active: false, windowId: me.windowId });
    await new Promise(r => setTimeout(r, 2000));
    const target = { tabId: tab.id };
    const page = f => chrome.scripting.executeScript({ target, func: f }).then(r => r[0].result);
    const visBefore = await page(() => document.visibilityState);
    const activeTab = (await chrome.tabs.query({ active: true, windowId: me.windowId }))[0]?.url;
    await chrome.debugger.attach(target, '1.3');
    const send = (m, p) => chrome.debugger.sendCommand(target, m, p);
    const click = await t((async () => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: 50, y: 70, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); })());
    await page(() => document.getElementById('i').focus());
    const ins = await t(send('Input.insertText', { text: 'hello' }));
    const key = await t((async () => { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 }); })());
    const shot = await t(send('Page.captureScreenshot', { format: 'jpeg' }));
    const res = await page(() => ({ title: document.title, value: document.getElementById('i').value }));
    await chrome.debugger.detach(target).catch(() => {});
    return { visBefore, activeTab, click, insertText: ins, key, screenshot: shot, ...res };
  })()`);
  console.log(JSON.stringify(out));
  chrome.kill(); srv.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
