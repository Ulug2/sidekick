// Runs every jsdom suite and prints one line per suite plus a total. Exit code 1 if anything fails.
// Real Chrome is separate: npm run test:chrome (needs a Chromium from `npx playwright install chromium`).
const { spawnSync } = require('child_process');
const path = require('path');
const SUITES = ['forms', 'safety', 'multitask', 'fixes', 'hardening', 'security', 'phase3', 'sites', 'verify', 'memory-session', 'brain', 'panel-v6', 'pages', 'v4', 'e2e', 'agent-cdp', 'engine', 'openai-profile', 'calc', 'numeric', 'docs', 'timeouts', 'scroll', 'region'];
// calc and numeric also prove the calculator never uses eval (Chrome's extension CSP forbids it).
const NO_EVAL = new Set(['calc', 'numeric']);
const only = process.argv.slice(2);
let pass = 0, total = 0, failed = [];
for (const name of SUITES.filter(s => !only.length || only.includes(s))) {
  const file = path.join(__dirname, `${name}-test.${name === 'docs' ? 'mjs' : 'js'}`);
  const r = spawnSync(process.execPath, [...(NO_EVAL.has(name) ? ['--disallow-code-generation-from-strings'] : []), file], { encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  let m = [...(r.stdout || '').matchAll(/(\d+)\/(\d+) passed/g)].pop();
  if (!m) { // suites without a summary line: count PASS/FAIL lines
    const p = (r.stdout.match(/^PASS/gm) || []).length, f = (r.stdout.match(/^FAIL/gm) || []).length;
    if (p + f) m = [null, String(p), String(p + f)];
  }
  if (m) { pass += +m[1]; total += +m[2]; }
  const ok = m && m[1] === m[2] && r.status === 0;
  if (!ok) failed.push({ name, out });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(16)} ${m ? `${m[1]}/${m[2]}` : 'crashed'}`);
}
console.log(`\n${pass}/${total} checks passed${failed.length ? `; failing suites: ${failed.map(f => f.name).join(', ')}` : ''}`);
for (const f of failed) console.log(`\n--- ${f.name} ---\n` + f.out.split('\n').filter(l => /FAIL|CRASH|Error/.test(l)).slice(0, 20).join('\n'));
process.exit(failed.length ? 1 : 0);
