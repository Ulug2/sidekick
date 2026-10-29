// Tests the in-page snapshot/action engine on a realistic application form.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'extension', 'page-agent.js'), 'utf8');
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  (' + x + ')' : ''}`);

const FORM = `<!doctype html><html><head><title>Apply · Acme</title></head><body>
<h1>Software Engineer Intern</h1>
<form id="app">
  <label for="fn">First Name</label><input id="fn" name="first_name" required>
  <label for="em">Email</label><input id="em" type="email" required>
  <div class="field"><div class="q">Resume/CV</div><button type="button" id="attach">Attach</button><input type="file" id="resume" style="display:none"></div>
  <label for="heard">How did you hear about us?</label>
  <select id="heard"><option value="">Select...</option><option value="li">LinkedIn</option><option value="ref">Referral</option></select>
  <div role="combobox" aria-label="Location" aria-expanded="false" tabindex="0" id="loc"><input id="locInput" aria-label="Location search"></div><div id="menu"></div>
  <fieldset><legend>Are you legally authorized to work in the US?</legend>
    <input type="radio" name="auth" id="ay" value="yes" class="vh" style="opacity:0"><label for="ay">Yes</label>
    <input type="radio" name="auth" id="an" value="no" class="vh" style="opacity:0"><label for="an">No</label>
  </fieldset>
  <div class="field"><div class="q">Why do you want to work at Acme?</div><textarea id="why"></textarea></div>
  <label for="pw">Create a password</label><input id="pw" type="password">
  <label for="card">Card number</label><input id="card" autocomplete="cc-number">
  <div role="alert">Email is required</div>
  <button type="submit" id="submit">Submit application</button>
  <input type="hidden" name="token" value="x">
  <div style="display:none"><button>Hidden button</button></div>
</form>
<script>
  window.events = [];
  document.querySelectorAll('input,textarea,select').forEach(el => el.addEventListener('input', () => events.push(el.id + '=' + el.value)));
  loc.addEventListener('click', () => {
    menu.innerHTML = ['New York, NY','Newark, NJ','San Francisco, CA'].map((t,i)=>'<div role="option" id="react-select-2-option-'+i+'">'+t+'</div>').join('');
    loc.setAttribute('aria-expanded','true');
  });
  menu.addEventListener('click', e => { const o = e.target.closest('[role=option]'); if (o) { window.chosen = o.textContent; menu.innerHTML=''; loc.dataset.value = o.textContent; } });
  document.getElementById('app').addEventListener('submit', e => { e.preventDefault(); window.submitted = true; });
  submit.addEventListener('click', () => { window.submitClicked = true; });
</script></body></html>`;

function prep(w) {
  const hidden = el => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { if (n.style?.display === 'none' || n.hidden) return true; } return false; };
  w.Element.prototype.getBoundingClientRect = function () {
    if (hidden(this) || this.classList.contains('vh')) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    return { left: 10, top: 100, width: 200, height: 24, right: 210, bottom: 124 };
  };
  // Approximate Chrome's innerText: block elements end with a line break.
  const BLOCK = /^(DIV|P|H[1-6]|LI|UL|OL|FIELDSET|LEGEND|FORM|SECTION|ARTICLE|MAIN|HEADER|FOOTER|TR|BR|TEXTAREA|SELECT)$/;
  const inner = n => n.nodeType === 3 ? n.data : n.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(n.tagName) || n.style?.display === 'none' ? '' :
    [...n.childNodes].map(inner).join('') + (BLOCK.test(n.tagName) ? '\n' : '');
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return inner(this).replace(/\n{2,}/g, '\n').trim(); }, configurable: true });
  w.PointerEvent = w.MouseEvent;
  w.CSS = { escape: s => s };
  w.Element.prototype.scrollIntoView = () => {};
  w.scrollBy = w.scrollTo = () => {};
  Object.defineProperty(w.HTMLInputElement.prototype, 'files', { get() { return this._files || []; }, set(v) { this._files = v; }, configurable: true });
  w.DataTransfer = class { constructor() { const arr = []; this.items = { add: f => arr.push(f) }; this.files = arr; } };
}
module.exports = { FORM, prep };

if (require.main === module) (async () => {
  const dom = new JSDOM(FORM, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://boards.example.com/acme/jobs/1' });
  const w = dom.window; prep(w);
  w.eval(src);
  const snap = w.skPageSnapshot({});
  const L = snap.elements;
  const find = re => L.find(l => re.test(l));
  const idOf = re => (find(re) || '').match(/^\[(\d+)\]/)?.[1];
  console.log(L.join('\n') + '\n');
  check('Labeled text fields listed with empty + required', !!find(/textbox "First Name" empty, required/));
  check('Hidden file input listed with its question, no duplicate', /^\[\d+\] file "Resume\/CV" no file$/.test(find(/file/) || ''), find(/file/));
  check('Card field flagged SENSITIVE', !!find(/"Card number" SENSITIVE \(user must type\)/), find(/Card/));
  check('Native select shows options', !!find(/select "How did you hear about us\?" selected: "Select\.\.\.", options: "Select\.\.\.", "LinkedIn", "Referral"/));
  check('Custom combobox listed', !!find(/combobox "Location"/));
  check('Styled radios listed with group question', !!find(/radio "Yes" question: "Are you legally authorized to work in the US\?", unchecked/), find(/radio "Yes"/));
  check('Unlabeled textarea gets nearby question', !!find(/textarea "" question: "Why do you want to work at Acme\?"/) || !!find(/textarea ".*question: "Why do you want/), find(/textarea/));
  check('Password field flagged', !!find(/PASSWORD \(user must type\)/));
  check('Hidden/hidden-type elements excluded', !find(/Hidden button/) && !find(/token/));
  check('Validation errors surfaced', snap.errors.includes('Email is required'));

  const act = a => w.skPageAct(a);
  let r = await act({ op: 'type', id: idOf(/First Name/), text: 'Ulugbek' });
  check('type sets value and fires input (React-safe)', r.ok && w.document.getElementById('fn').value === 'Ulugbek' && w.events.includes('fn=Ulugbek'));
  r = await act({ op: 'select_option', id: idOf(/How did you hear/), option: 'linkedin' });
  check('select_option on native select (case-insensitive)', r.ok && w.document.getElementById('heard').value === 'li', r.note);
  r = await act({ op: 'select_option', id: idOf(/combobox "Location"/), option: 'New York' });
  check('select_option on custom dropdown opens + clicks option', r.ok && w.chosen === 'New York, NY', r.note || r.error);
  r = await act({ op: 'set_checked', id: idOf(/radio "Yes"/), checked: true });
  check('set_checked on hidden radio via its label', r.ok && w.document.getElementById('ay').checked);
  r = await act({ op: 'set_checked', id: idOf(/radio "Yes"/), checked: true });
  check('set_checked is idempotent', r.ok && r.note === 'Already in that state.');
  r = await act({ op: 'upload_file', id: idOf(/file "Resume/), file: { name: 'resume.pdf', type: 'application/pdf', base64: Buffer.from('%PDF-1.4 hi').toString('base64') } });
  const f = w.document.getElementById('resume').files[0];
  check('upload_file attaches resume', r.ok && f?.name === 'resume.pdf' && f.type === 'application/pdf');
  r = await act({ op: 'type', id: idOf(/textarea/), text: 'Because…' });
  check('type into textarea', r.ok && w.document.getElementById('why').value === 'Because…');
  r = await act({ op: 'type', id: idOf(/Create a password/), text: 'hunter2' });
  check('GUARD: refuses password field', !r.ok && /never fills/.test(r.error) && w.document.getElementById('pw').value === '');
  r = await act({ op: 'type', id: idOf(/Card number/), text: '4242' });
  check('GUARD: refuses card field by autocomplete', !r.ok && w.document.getElementById('card').value === '');
  r = await act({ op: 'type', id: idOf(/First Name/), text: '4242 4242 4242 4242' });
  check('GUARD: refuses card-number-looking text anywhere', !r.ok && w.document.getElementById('fn').value === 'Ulugbek');
  r = await act({ op: 'type', id: idOf(/First Name/), text: '123-45-6789' });
  check('GUARD: refuses SSN-looking text', !r.ok);
  r = await act({ op: 'press_key', id: idOf(/First Name/), key: 'Enter' });
  check('Enter in a big form does NOT submit it', r.ok && !w.submitted, r.note);
  r = await act({ op: 'click', id: '9999' });
  check('Stale id gives a helpful error', !r.ok && /isn't on the page anymore/.test(r.error));
  const snap2 = w.skPageSnapshot({});
  check('Ids are stable across snapshots', snap2.elements.find(l => /First Name/.test(l)).startsWith(`[${idOf(/First Name/)}]`) && /value: "Ulugbek"/.test(snap2.elements.join('\n')));
  r = await act({ op: 'click', id: idOf(/Submit application/) });
  check('click fires real click', r.ok && w.submitClicked === true);
  r = await act({ op: 'read_text' });
  check('read_text returns page text', r.ok && r.text.includes('Software Engineer Intern'));
  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
})();
