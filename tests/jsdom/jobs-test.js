// The Jobs page: sponsor lists, scanning company job boards, the eligible list, today's batch,
// statuses, companies, CSV export. The web's text (titles, companies) is rendered as text only.
// Job boards and the government lists are faked; no model is called.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, makeStore, loadScripts, fs, srcPath, sleep } = H;
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 1200).replace(/\n/g, '\n        ') : ''}`);

const UK_CSV = 'Organisation Name,Town/City,County,Type & Rating,Route\n"Stripe Payments UK Ltd",London,,Worker (A rating),Skilled Worker\n';
const US_CSV = '"Fiscal Year",Employer,"Initial Approval","Initial Denial","Continuing Approval","Continuing Denial",NAICS,"Tax ID",State,City,ZIP\n2023,"STRIPE, INC.",20,1,44,0,51,1234,CA,SOUTH SAN FRANCISCO,94080\n2023,"EVIL CORP",9,0,0,0,51,1,NY,NEW YORK,10001\n';
const GH = (board) => ({ jobs: [
  { id: 1, absolute_url: `https://job-boards.greenhouse.io/${board}/jobs/1`, title: 'Software Engineer, New Grad', location: { name: 'New York, NY' }, first_published: new Date(Date.now() - 2 * 864e5).toISOString(), content: 'Build payments. We sponsor visas.' },
  { id: 2, absolute_url: `https://job-boards.greenhouse.io/${board}/jobs/2`, title: 'Senior Staff Engineer', location: { name: 'New York, NY' }, first_published: '2026-10-01T00:00:00Z', content: 'x' },
  { id: 3, absolute_url: `https://job-boards.greenhouse.io/${board}/jobs/3`, title: '<img src=x onerror="window.pwned=1"> Backend Engineer <b>bold</b>', location: { name: 'London, UK' }, first_published: '2026-11-01T00:00:00Z', content: 'Must have the right to work in the UK.' },
  { id: 4, absolute_url: `https://job-boards.greenhouse.io/${board}/jobs/4`, title: 'Software Engineer', location: { name: 'Singapore' }, content: 'x' }
] });

async function page(store = {}) {
  const html = fs.readFileSync(srcPath('jobs.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const local = makeStore({ anthropicKey: 'k', profile: { fullName: 'Ulugbek Khairulla', desiredRoles: 'Software Engineer, Backend' }, ...store });
  const session = makeStore();
  const w = new JSDOM(html, { runScripts: 'outside-only', url: 'chrome-extension://abc/jobs.html' }).window;
  const calls = { open: [], fetched: [], downloads: [] };
  const listeners = [];
  w.chrome = {
    storage: { local, session, onChanged: { addListener(fn) { listeners.push(fn); } } },
    windows: { getCurrent: async () => ({ id: 3 }) },
    sidePanel: { open: async o => { calls.open.push(o); } },
    runtime: { getURL: p => p, getManifest: () => ({ version: '0.9.6' }) }
  };
  // The fake web: two Greenhouse boards, GOV.UK's content API and the two CSV files.
  w.fetch = async (u) => {
    calls.fetched.push(String(u));
    const url = String(u);
    const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    const text = t => new Response(t, { status: 200 });
    if (/boards-api\.greenhouse\.io\/v1\/boards\/(stripe|evilcorp)\/jobs/.test(url)) return json(GH(url.match(/boards\/(\w+)/)[1]));
    if (/boards-api\.greenhouse\.io\/v1\/boards\/gone\//.test(url)) return new Response('nope', { status: 404 });
    if (/gov\.uk\/api\/content/.test(url)) return json({ public_updated_at: '2026-11-06T08:44:34+00:00', details: { attachments: [{ url: 'https://assets.publishing.service.gov.uk/x/Worker_and_Temporary_Worker.csv', title: 'Register of Worker and Temporary Worker licensed sponsors' }] } });
    if (/Worker_and_Temporary_Worker\.csv/.test(url)) return text(UK_CSV);
    if (/h1b_datahubexport-2023\.csv/.test(url)) return text(US_CSV);
    if (/h1b_datahubexport-2022\.csv/.test(url)) return new Response('', { status: 404 });
    return new Response('', { status: 404 });
  };
  w.URL.createObjectURL = blob => { calls.downloads.push(blob); return 'blob:x'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { calls.clicked = this.download; };
  loadScripts(w, ['jobs.js'], ['render']);
  await sleep(80);
  // Storage changes made by the page itself reach its own listener, as in Chrome.
  const origSet = local.set;
  local.set = async o => { await origSet(o); for (const fn of listeners) fn(Object.fromEntries(Object.keys(o).map(k => [k, { newValue: o[k] }])), 'local'); };
  return { w, doc: w.document, local, session, calls, text: sel => (w.document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim() };
}
const click = (doc, sel) => { const el = doc.querySelector(sel); if (!el) throw new Error(`no ${sel}`); el.click(); };
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(30); } return await fn(); };

(async () => {
  // ---------- 1. first open: no lists, the seed companies, empty list with the next step ----------
  const p = await page();
  const { doc, local, session, calls } = p;
  check('Shows the seed companies and that the sponsor lists aren\'t downloaded yet', /SPONSOR LISTS not downloaded/.test(p.text('#sysline')) && /COMPANIES \d{2,}/.test(p.text('#sysline')) && (await local.get('jobCompanies')).jobCompanies.length > 60, p.text('#sysline'));
  check('Empty list says what to do first', /Download the sponsor lists first/.test(p.text('#empty')));
  check('Settings default to 20 a day and $25 a month', doc.querySelector('#dailyCap').value === '20' && doc.querySelector('#monthlyCap').value === '25');

  // ---------- 2. sponsor lists ----------
  click(doc, '#sponsors');
  await until(() => /Sponsor lists updated/.test(p.text('#progress')));
  const lists = (await local.get('sponsorLists')).sponsorLists;
  check('Update sponsor lists: finds the current UK CSV through GOV.UK\'s API, reads both files, keeps names only', /Sponsor lists updated: 1 UK sponsors \(2026-11-06\), 2 US H-1B employers \(FY2023\)/.test(p.text('#progress')) && lists.uk[0] === 'stripe payments' && lists.us.stripe === 64 && calls.fetched.some(u => /gov\.uk\/api\/content/.test(u)), p.text('#progress'));
  check('The status line shows the lists\' dates', /UK 2026-11-06 · US H-1B FY2023/.test(p.text('#sysline')), p.text('#sysline'));

  // ---------- 3. scan two boards: only jobs he can take, ordered, text only ----------
  await local.set({ jobCompanies: [{ name: 'Stripe', ats: 'greenhouse', board: 'stripe', added: 1, source: 'seed' }, { name: 'Evil Corp', ats: 'greenhouse', board: 'evilcorp', added: 1, source: 'seed' }, { name: 'Gone Co', ats: 'greenhouse', board: 'gone', added: 1, source: 'you' }] });
  click(doc, '#scan');
  await until(() => /^Scanned/.test(p.text('#progress')));
  const jobs = (await local.get('jobs')).jobs;
  check('Scan: 3 boards read, eligible jobs counted, the missing board reported', /Scanned 3 boards: 2 eligible jobs; 1 board failed/.test(p.text('#progress')) && jobs.length === 8, p.text('#progress'));
  const rows = [...doc.querySelectorAll('#list .job')];
  check('To apply: one eligible job per board (the new-grad role; senior, no-right-to-work and Singapore filtered out), with the reason it qualifies', rows.length === 2 && rows.every(r => /Software Engineer, New Grad/.test(r.textContent)) && /Posting offers visa sponsorship/.test(rows[0].textContent) && /Sponsored 64 H-1B visas/.test(rows.find(r => /Stripe/.test(r.textContent)).textContent), rows.map(r => r.textContent.slice(0, 200)).join('\n'));
  check('Tabs count what\'s where', p.text('#tabs [data-tab=apply] .n') === '2' && p.text('#tabs [data-tab=filtered] .n') === '6' && p.text('#tabs [data-tab=companies] .n') === '3', p.text('#tabs'));
  click(doc, '#tabs [data-tab=filtered]');
  await sleep(50);
  const filtered = [...doc.querySelectorAll('#list .job')];
  check('Filtered out: each job shows why, as text (a script tag in a title does nothing)', filtered.length === 6 && filtered.some(r => /Senior Staff Engineer/.test(r.textContent) && /Not one of your target roles/.test(r.textContent)) && filtered.some(r => /Says: “Must have the right to work in the UK”/.test(r.textContent)) && filtered.some(r => /Not in the US, Europe or the UAE \(Singapore\)/.test(r.textContent)) && !doc.querySelector('#list img') && !doc.querySelector('#list b') && !p.w.pwned, filtered.map(r => r.textContent.slice(0, 160)).join('\n'));
  click(doc, '#tabs [data-tab=companies]');
  await sleep(50);
  check('Companies: each board\'s last scan and the failed one\'s error', /Stripe/.test(p.text('#companies')) && /1 matching/.test(p.text('#companies')) && /Gone Co has no greenhouse board called “gone”/.test(p.text('#companies')), p.text('#companies'));

  // ---------- 4. keep a filtered job, skip one, build the batch, start it ----------
  click(doc, '#tabs [data-tab=filtered]');
  await sleep(50);
  const keepRow = [...doc.querySelectorAll('#list .job')].find(r => /Senior Staff/.test(r.textContent) && /Stripe/.test(r.textContent));
  [...keepRow.querySelectorAll('button')].find(b => b.textContent === 'Keep anyway').click();
  await until(() => (p.text('#tabs [data-tab=apply] .n')) === '3');
  check('"Keep anyway" moves a filtered job to the list, marked as your choice', (await local.get('jobs')).jobs.find(j => /Senior/.test(j.title) && j.board === 'stripe').why[0] === 'You kept it');
  click(doc, '#tabs [data-tab=apply]');
  await sleep(50);
  const skipRow = [...doc.querySelectorAll('#list .job')].find(r => /Senior Staff/.test(r.textContent));
  [...skipRow.querySelectorAll('button')].find(b => b.textContent === 'Skip').click();
  await until(() => p.text('#tabs [data-tab=apply] .n') === '2');
  click(doc, '#build');
  await until(() => /jobs in today's batch/.test(p.text('#progress')));
  const queued = (await local.get('jobs')).jobs.filter(j => j.status === 'queued');
  check('Build today\'s batch: the eligible jobs are queued (one per company) and Approve appears', /2 jobs in today's batch/.test(p.text('#progress')) && queued.length === 2 && !doc.querySelector('#start').hidden && p.text('#hud').includes("today's batch"), p.text('#progress'));
  click(doc, '#build');
  await until(() => /No eligible jobs left/.test(p.text('#progress')));
  check('Building again adds nothing (one application per company per month)', /No eligible jobs left to add/.test(p.text('#progress')));
  click(doc, '#start');
  await until(async () => (await session.get('jobBatch')).jobBatch, 1000);
  const batch = (await session.get('jobBatch')).jobBatch;
  check('Approve & start: opens the side panel (inside the click) and hands the batch over in session storage', calls.open.length === 1 && calls.open[0].windowId === 3 && batch && Date.now() - batch.ts < 5000 && batch.windowId === 3, JSON.stringify(batch));
  click(doc, '#stop');
  await sleep(30);
  check('Stop asks the panel to end the batch after the current job', (await session.get('jobBatchStop')).jobBatchStop === true && !(await session.get('jobBatch')).jobBatch);

  // ---------- 5. statuses and the spreadsheet ----------
  const first = queued[0];
  await local.set({ jobs: (await local.get('jobs')).jobs.map(j => j.id === first.id ? { ...j, status: 'applied', appliedAt: Date.now(), coverLetter: 'Hi team,\n\nA letter.\n\nThanks,\nUlugbek' } : j) });
  await sleep(60);
  check('Applied today counts against the daily limit on the HUD', /1 \/ 20/.test(p.text('#hud')), p.text('#hud'));
  click(doc, '#tabs [data-tab=applied]');
  await sleep(50);
  const applied = doc.querySelector('#list .job');
  check('Applied: status dropdown and the cover letter it sent, as text', applied && applied.querySelector('select').value === 'applied' && /Cover letter/.test(applied.textContent) && applied.querySelector('pre').textContent.includes('A letter.'));
  applied.querySelector('select').value = 'interview';
  applied.querySelector('select').dispatchEvent(new p.w.Event('change'));
  await until(async () => (await local.get('jobs')).jobs.find(j => j.id === first.id).status === 'interview', 1000);
  check('Changing the status saves it', (await local.get('jobs')).jobs.find(j => j.id === first.id).status === 'interview');
  click(doc, '#exportCsv');
  await until(() => calls.downloads.length === 1, 1000);
  const csv = await calls.downloads[0].text();
  check('Export spreadsheet: one CSV row per job with status, priority, sponsorship and links', /^status,priority,company,title,location,region,sponsorship,why,posted,applied,link,apply_link,note$/m.test(csv) && /^interview,\d+,/m.test(csv) && /Not one of your target roles/.test(csv) && /^skipped,/m.test(csv) && calls.clicked.startsWith('sidekick-jobs-'), csv.slice(0, 400));

  // ---------- 6. add a company from a careers link ----------
  click(doc, '#tabs [data-tab=companies]');
  await sleep(50);
  doc.querySelector('#careersUrl').value = 'https://job-boards.greenhouse.io/evilcorp/jobs/1';
  doc.querySelector('#companyName').value = 'Evil Corp';
  doc.querySelector('#addCompany').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
  await sleep(100);
  doc.querySelector('#careersUrl').value = 'https://careers.example.com/openings';
  doc.querySelector('#addCompany').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
  await sleep(60);
  check('Add company: a non-board link is explained; a known board isn\'t added twice', /isn't a Greenhouse, Lever, Ashby, Workable or SmartRecruiters job board/.test(p.text('#progress')) && (await local.get('jobCompanies')).jobCompanies.filter(c => c.board === 'evilcorp').length === 1, p.text('#progress'));

  // ---------- 7. the monthly limit ----------
  await local.set({ usage: { [new Date().toLocaleDateString('en-CA')]: { 'claude-sonnet-5-5': { calls: 1, input: 20000000, output: 0, cacheRead: 0, cacheWrite: 0 } } } });
  await until(() => !doc.querySelector('#warning').hidden, 1500);
  check('Over the monthly API limit: a warning, and the batch won\'t start', !doc.querySelector('#warning').hidden && /reached your limit of \$25/.test(p.text('#warning')), p.text('#warning') + ' | ' + p.text('#sysline') + ' | hidden=' + doc.querySelector('#warning').hidden);

  console.log(results.join('\n'));
  const passed = results.filter(r => r.startsWith('PASS')).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.log(results.join('\n')); console.log('CRASH', e.stack); process.exit(1); });
