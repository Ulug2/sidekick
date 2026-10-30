// The prompts and tool definitions the models see, compared with a saved copy
// (tests/fixtures/prompts.json). Moving code between files must not change a single character.
// After an intended prompt change: UPDATE_PROMPTS=1 node tests/jsdom/prompts-test.js
process.env.TZ = 'America/New_York';
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, makeStore, loadScripts, fs } = H;
const GOLDEN = require('path').join(__dirname, '..', 'fixtures', 'prompts.json');
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 900).replace(/\n/g, '\n        ') : ''}`);

const FIXED = Date.parse('2026-11-04T15:30:00Z');
const profile = { fullName: 'Jordan Example', email: 'jordan@example.edu', city: 'Gettysburg', state: 'PA', desiredRoles: 'Backend engineer', aboutMe: 'CS student', resume: { name: 'resume.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBERi0=', text: 'Jordan Example. Skills: TypeScript.' } };
const memories = [
  { id: 'aaaaaaaa-1', text: 'Prefers short answers', kind: 'preference', created: 1, updated: 1 },
  { id: 'bbbbbbbb-2', text: 'Takes Calculus III', kind: 'fact', created: 1, updated: 1 }
];
const skills = [{ id: 'k_1', name: 'MyOpenMath answers', when: 'Entering answers on MyOpenMath', body: '- round to 4 decimals', created: 1, updated: 1, uses: 0, version: 1, source: 'learned' }];

(async () => {
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/x.html' }).window;
  const RealDate = w.Date;
  w.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [FIXED])); } static now() { return FIXED; } };
  w.chrome = { storage: { local: makeStore({ profile, memories, skills, userModel: { text: 'Likes worked examples.', updated: 1 }, assistantName: 'Jarvis', customInstructions: 'Use British spelling.' }), session: makeStore() }, runtime: { getURL: p => p } };
  loadScripts(w, ['agent.js', 'brain.js'], ['agentSystemPrompt', 'CHECK_SYSTEM', 'AGENT_TOOLS', 'buildSystemPrompt', 'chatTools', 'getSettings', 'SETUP_FORMAT', 'PERSONALITIES']);
  const s = await w.getSettings();
  const now = {
    agentSystemPrompt: w.agentSystemPrompt({ ...(await (async () => profile)()), useInChat: true }, { memories, assistantName: 'Jarvis' }),
    checkSystem: w.CHECK_SYSTEM,
    agentTools: JSON.stringify(w.AGENT_TOOLS, null, 1),
    setupFormat: w.SETUP_FORMAT,
    personalities: JSON.stringify(w.PERSONALITIES, null, 1)
  };
  for (const provider of ['anthropic', 'openai']) {
    for (const hasAgent of [true, false]) {
      for (const builtInSearch of [true, false]) {
        now[`system:${provider}:agent=${hasAgent}:search=${builtInSearch}`] = await w.buildSystemPrompt(s, { model: provider === 'openai' ? 'gpt-5.6-terra' : 'claude-sonnet-5-5', provider, hasAgent, builtInSearch });
        now[`chatTools:${provider}:agent=${hasAgent}:search=${builtInSearch}`] = JSON.stringify(w.chatTools({ provider, webSearchServer: builtInSearch, hasTab: true, hasAgent }), null, 1);
      }
    }
  }
  now['chatTools:noTab'] = JSON.stringify(w.chatTools({ hasTab: false, hasAgent: false, webSearchServer: true }), null, 1);

  if (process.env.UPDATE_PROMPTS) {
    fs.writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n');
    console.log(`Saved ${Object.keys(now).length} prompts to ${GOLDEN}`);
  }
  const saved = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  for (const k of Object.keys(saved)) {
    const a = saved[k], b = now[k];
    let at = 0; while (at < Math.min(a.length, (b || '').length) && a[at] === b[at]) at++;
    check(`Unchanged: ${k}`, a === b, b === undefined ? 'missing now' : `first difference at character ${at}:\n  saved: ${JSON.stringify(a.slice(at, at + 120))}\n  now:   ${JSON.stringify(String(b).slice(at, at + 120))}`);
  }
  check('No new prompts that are not in the saved copy', Object.keys(now).every(k => k in saved), Object.keys(now).filter(k => !(k in saved)).join(', '));
  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); console.log(results.join('\n')); process.exit(1); });
