// v0.9.4: travel-style forms (Ulugbek, 2026-10-29: "It still can't even find tickets" on
// turkishairlines.com). Against a faithful copy of the site's booking form (fixtures/airline.html):
// autocomplete airports, a react-calendar date picker, and multi-city legs with repeated labels.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, sleep, makeStore, sseResponse, anthropicEvents, loadScripts, fs } = H;
const { prep } = require(require('path').join(__dirname, 'engine-test.js'));
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 1500).replace(/\n/g, '\n        ') : ''}`);
const text = t => sseResponse(anthropicEvents([{ type: 'text', text: t }]));
const tools = (calls, step) => sseResponse(anthropicEvents(calls.map(([name, input], k) => ({ type: 'tool_use', id: `t${step}_${k}`, name, input })), { stop: 'tool_use' }));
const AGENT = ['ai.js', 'guard.js', 'profile-core.js', 'memory.js', 'skills.js', 'docs.js', 'web.js', 'screen.js', 'page-agent.js', 'cdp.js', 'adapters.js', 'agent.js'];
const AIRLINE = fs.readFileSync(require('path').join(__dirname, '..', 'fixtures', 'airline.html'), 'utf8');
const URL0 = 'https://www.turkishairlines.com/en-us/';

// Id of the element with this role and label, in the given row ("2. Flight"), from the newest snapshot.
const idOf = (all, role, label, row) => {
  const re = new RegExp(String.raw`\[(\d+)\] ` + role + String.raw` \\"` + label + String.raw`\\"[^\[]*?` + (row ? String.raw`row: \\"` + row.replace('.', '\\.') + String.raw`\\"` : ''), 'g');
  let m, id = null; while ((m = re.exec(all))) id = m[1]; return id;
};

async function run(plan, goal = 'Find the cheapest multi-city flights on Turkish Airlines: IAD to IST on December 10, IST to ALA on December 15, then back to IAD on January 25.') {
  const page = new JSDOM(AIRLINE, { runScripts: 'dangerously', pretendToBeVisual: true, url: URL0 }).window;
  prep(page);
  page.document.elementFromPoint = () => null;
  await sleep(20);
  const local = makeStore({ anthropicKey: 'k', profile: { fullName: 'Ulugbek Rivera' } });
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/sidepanel.html' }).window;
  w.chrome = {
    storage: { local, session: makeStore() },
    tabs: { query: async () => [{ id: 5, windowId: 1, active: true, url: URL0, title: 'Turkish Airlines' }], get: async () => ({ id: 5, windowId: 1, active: true, status: 'complete', url: URL0, title: 'Turkish Airlines' }), update: async () => ({}), onCreated: { addListener() {}, removeListener() {} }, onActivated: { addListener() {}, removeListener() {} } },
    scripting: { executeScript: async ({ func, args }) => [{ frameId: 0, result: JSON.parse(JSON.stringify((await page.eval(`(${func.toString()})`)(...(args || []))) ?? null)) }] },
    debugger: { attach: async () => { throw new Error('no'); }, detach: async () => {}, onDetach: { addListener() {}, removeListener() {} }, sendCommand: async () => ({}) },
    runtime: { getURL: p => p }
  };
  const reqs = [];
  w.fetch = async (u, o) => {
    const body = JSON.parse(o.body);
    { const ck = H.checkerReply(body); if (ck) return ck; }
    reqs.push(body);
    if (/reusable operating notes/.test(body.system || '')) return text('{"notes":[]}');
    const step = body.messages.filter(m => m.role === 'assistant').length;
    const r = plan(step, JSON.stringify(body.messages));
    return Array.isArray(r) ? tools(r, step) : text(r);
  };
  loadScripts(w, AGENT, ['runAgent']);
  const steps = [];
  const ui = { signal: new AbortController().signal, step: t => { const s = { t }; steps.push(s); return { waiting() {}, done: (ok, d) => { s.ok = ok; s.d = d; } }; }, note() {}, approve: async () => true, ask: async () => 'ok', thinking() {}, plan() {} };
  const r = await w.runAgent(goal, ui);
  return { r, steps, reqs, page };
}
const show = st => st.map(s => `${s.ok === false ? '✗' : '✓'} ${s.t}${s.d ? ' — ' + s.d : ''}`).join('\n');

(async () => {
  // ---------- one-way: the exact calls that failed on the real site ----------
  {
    let snap0 = '';
    const res = await run((step, all) => [
      () => { snap0 = all; return [['select_option', { id: idOf(all, 'combobox', 'From'), option: 'Washington DC (IAD)' }]]; },
      () => [['select_option', { id: idOf(all, 'combobox', 'To'), option: 'Istanbul (IST)' }]],
      () => [['pick_date', { id: idOf(all, 'button', 'Dates'), date: '2026-12-10' }]],
      () => [['done', { summary: 'ok' }]]][step]());
    const b = res.page.booking[0];
    check('Airport by code: "Washington DC (IAD)" → Dulles International Airport (IAD), not the "(All)" entry', b.from === 'IAD' && /Selected "Dulles International Airport\(IAD\)/.test(res.steps[0].d || ''), show(res.steps));
    check('An autocomplete that shows nothing until you type: types "IST", picks Istanbul Airport (IST)', b.to === 'IST' && /Istanbul Airport\(IST\)/.test(res.steps[1].d || ''), show(res.steps));
    check('Calendar: moves from October to December and clicks December 10 (react-calendar day labels)', b.date === '2026-12-10' && /Picked December 10, 2026/.test(res.steps[2].d || ''), show(res.steps));
    check('The step list shows what was actually chosen', /^Choose “Washington DC \(IAD\)” in “From”$/.test(res.steps[0].t) && /^Pick Dec 10, 2026 in “Dates”$/.test(res.steps[2].t), show(res.steps));
  }
  // ---------- one step for everything: fill_fields takes the airports and the date together ----------
  {
    const res = await run((step, all) => [
      () => [['fill_fields', { fields: [{ id: idOf(all, 'combobox', 'From'), value: 'Washington DC (IAD)' }, { id: idOf(all, 'combobox', 'To'), value: 'Istanbul (IST)' }, { id: idOf(all, 'button', 'Dates'), value: '2026-12-10' }] }]],
      () => [['done', { summary: 'ok' }]]][step]());
    const b = res.page.booking[0];
    check('fill_fields fills two autocompletes and a calendar date (YYYY-MM-DD) in one step, no extra model turns', b.from === 'IAD' && b.to === 'IST' && b.date === '2026-12-10' && res.steps.filter(s => /^Fill 3 fields/.test(s.t)).length === 1, show(res.steps));
  }

  // ---------- the whole multi-city search ----------
  {
    const R = (all, role, label, row) => idOf(all, role, label, row);
    let afterRows = '', results = '';
    const res = await run((step, all) => [
      () => [['click', { id: all.match(/\[(\d+)\] button \\"Multi-city\\"/)[1], description: 'Switch to multi-city', final_action: false }]],
      () => [['click', { id: all.match(/\[(\d+)\] button \\"Add flight\\"/)[1], description: 'Add a third flight', final_action: false }]],
      () => { afterRows = all; return [['select_option', { id: R(all, 'combobox', 'From', '1. Flight'), option: 'Washington Dulles (IAD)' }], ['select_option', { id: R(all, 'combobox', 'To', '1. Flight'), option: 'Istanbul (IST)' }], ['pick_date', { id: R(all, 'button', 'Dates', '1. Flight'), date: '2026-12-10' }],
        ['select_option', { id: R(all, 'combobox', 'From', '2. Flight'), option: 'Istanbul (IST)' }], ['select_option', { id: R(all, 'combobox', 'To', '2. Flight'), option: 'Almaty (ALA)' }], ['pick_date', { id: R(all, 'button', 'Dates', '2. Flight'), date: '2026-12-15' }],
        ['select_option', { id: R(all, 'combobox', 'From', '3. Flight'), option: 'Almaty (ALA)' }], ['select_option', { id: R(all, 'combobox', 'To', '3. Flight'), option: 'Washington Dulles (IAD)' }], ['pick_date', { id: R(all, 'button', 'Dates', '3. Flight'), date: '2027-01-25' }]]; },
      () => [['click', { id: all.match(/\[(\d+)\] button \\"Search flights\\"/)[1], description: 'Search flights', final_action: false }]],
      () => [['find', { query: 'best total price' }]],
      () => { results = all; return [['done', { summary: 'Best total: USD 1,243.30' }]]; }][step]());
    check('Repeated fields say which leg they belong to (row: "2. Flight")', /combobox \\"From\\"[^\[]*row: \\"1\. Flight\\"/.test(afterRows) && /combobox \\"To\\"[^\[]*row: \\"3\. Flight\\"/.test(afterRows) && /button \\"Dates\\"[^\[]*row: \\"2\. Flight\\"/.test(afterRows), afterRows.slice(0, 2500));
    check('All three legs filled: IAD→IST Dec 10, IST→ALA Dec 15, ALA→IAD Jan 25 2027', JSON.stringify(res.page.booking) === JSON.stringify([{ from: 'IAD', to: 'IST', date: '2026-12-10' }, { from: 'IST', to: 'ALA', date: '2026-12-15' }, { from: 'ALA', to: 'IAD', date: '2027-01-25' }]), JSON.stringify(res.page.booking) + '\n' + show(res.steps));
    check('Search ran and the fares were found without scrolling', res.page.searched === 1 && /best total price for the flights you have selected: USD 1,243\.30/.test(results) && !res.steps.some(s => /^Scroll|Click at/.test(s.t)), show(res.steps));
    check(`Whole search in ${res.reqs.length} model calls (v0.9.3 gave up after 23 steps)`, res.reqs.length <= 7 && res.steps.every(s => s.ok !== false), show(res.steps));
  }
  // ---------- failures are clear ----------
  {
    const res = await run((step, all) => [
      () => [['select_option', { id: idOf(all, 'combobox', 'To'), option: 'Atlantis (XYZ)' }]],
      () => [['pick_date', { id: idOf(all, 'button', 'Dates'), date: '2026-10-01' }]],
      () => [['done', { summary: 'ok' }]]][step]());
    check('No such airport: a clear error, no wrong pick', res.steps[0].ok === false && /found no option like "Atlantis \(XYZ\)"/.test(res.steps[0].d) && !res.page.booking[0].to, res.steps[0].d);
    check('Only the field\'s own list is offered, never header/nav links (v0.9.3 offered "Corporate Club", "EN-US")', /See all destinations/.test(res.steps[0].d) && !/Corporate Club|EN-US|Holidays/.test(res.steps[0].d), res.steps[0].d);
    check('A past (greyed-out) date: says it can\'t be chosen', res.steps[1].ok === false && /can't be chosen/.test(res.steps[1].d), res.steps[1].d);
  }
  {
    const sys = (await run(() => 'ok.')).reqs[0].system;
    check('Prompt: select_option for autocompletes, pick_date for calendars, dates roll into next year, add-on prices, never book or pay', /pick_date with YYYY-MM-DD/.test(sys) && /"January 25" is 2027-01-25/.test(sys) && /\+USD 45/.test(sys) && /Never book or pay/.test(sys));
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); console.log(results.join('\n')); process.exit(1); });
