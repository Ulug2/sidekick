// v0.7.3 double-check: evidence beats opinion, tie-break on the strongest model, no silent swaps.
const H = require(require('path').join(__dirname, 'helpers.js'));
const { srcPath } = require(require('path').join(__dirname, 'helpers.js'));
const { JSDOM, sleep, makeStore, sseResponse, anthropicEvents, openaiEvents, loadScripts, fs, DIR, PANEL_SCRIPTS } = H;
const results = []; const check = (n, ok, x = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x && !ok ? '\n        ' + String(x).slice(0, 900).replace(/\n/g, '\n        ') : ''}`);
const BRAIN = ['vendor/math.js', 'vendor/nerdamer.js', 'ai.js', 'guard.js', 'profile-core.js', 'memory.js', 'skills.js', 'docs.js', 'web.js', 'screen.js', 'calc.js', 'session.js', 'brain.js'];
const SHOT = 'data:image/jpeg;base64,SCREENSHOT';

const isChecker = b => /meticulous checker/.test(b.system || b.instructions || '');
const isSolver = b => /independent problem solver/.test(b.system || b.instructions || '');
const firstUserText = b => JSON.stringify(b.messages ? b.messages[0] : b.input?.[0] ?? '');
const lastToolResult = b => { const last = b.messages?.at(-1); return (last?.content || []).find?.(c => c.type === 'tool_result'); };

// ---- the pipeline problem (MATH 211 HW 4.7 Q10) ----
const PIPE_Q = 'Can u solve this and give me just an answer?';
const OBJ = '40*sqrt(x^2 + 4) + 46*sqrt(y^2 + 1) + 36*(10 - x - y)';
const setup = (goal, answer, constraints = '0 <= x <= 10, 0 <= y <= 10, x + y <= 10') => '```setup\nvariables: x = horizontal run P→Q (mi), y = horizontal run Q→R (mi)\ngoal: ' + goal + '\nconstraints: ' + constraints + '\nanswer: ' + answer + '\n```';
const RIGHT_PIPE = '**x ≈ 4.1295, y ≈ 1.2572**\n\n`4.1295, 1.2572`\n\n' + setup('minimize ' + OBJ, 'x = 4.1295, y = 1.2572');
const WRONG_PIPE_FINAL = '**x ≈ 0.9052, y ≈ 0.4352**\n\n`0.9052, 0.4352`';
const WRONG_PIPE = WRONG_PIPE_FINAL + '\n\n' + setup('minimize ' + OBJ, 'x = 0.9052, y = 0.4352');

// ---- the cone problem ----
const ASK = "Solve this and just give me the answer, i don't need solution or anything. Just answers.";
const WRONG = 'The points on the cone $z^2 = x^2 + y^2$ closest to $(6,2,0)$ are $(3, 1, \\sqrt{10})$ and $(-3, -1, \\sqrt{10})$.';
const RIGHT = '$(3, 1, \\sqrt{10})$ and $(3, 1, -\\sqrt{10})$\n\n`(3,1,sqrt(10)), (3,1,-sqrt(10))`';

function boot(storeInit, responder, extra = {}) {
  const w = new JSDOM('<!doctype html><head></head><body></body>', { runScripts: 'outside-only', url: 'chrome-extension://abc/x.html' }).window;
  w.chrome = { storage: { local: makeStore(storeInit), session: makeStore() }, runtime: { getURL: p => p }, ...extra };
  const reqs = [];
  w.fetch = async (u, o) => { const b = JSON.parse(o.body); reqs.push(b); return responder(b, reqs); };
  loadScripts(w, BRAIN, ['runTurn', 'buildSystemPrompt', 'getSettings', 'needsCheck', 'routeMessage', 'parseVerdict', 'arbitrate', 'parseSetup', 'JUST_ANSWER']);
  return { w, reqs };
}
const text = t => sseResponse(anthropicEvents([{ type: 'text', text: t }]));
function chipsUi(extra = {}) {
  const chips = [];
  return { chips, ui: { hasTab: false, onToolStart: (n) => { const c = { n }; chips.push(c); return { done: s => (c.done = s), fail: m => (c.fail = m) }; }, ...extra } };
}

(async () => {
  // ---------- 1. THE BUG: right answer, the checker failed but said "incorrect" ----------
  {
    const { w, reqs } = boot({ anthropicKey: 'k' }, b => {
      if (isChecker(b)) return text(setup('minimize ' + OBJ, 'x = 0.9052, y = 0.4352') + '\n<verdict>incorrect</verdict><proposed_values>x = 4.1295, y = 1.2572</proposed_values><final_answer>' + WRONG_PIPE_FINAL + '\n\nA systematic re-evaluation might be needed.</final_answer><reason>Failed to compute a consistent and valid solution; no real solution was found using provided equations.</reason>');
      if (isSolver(b)) throw new Error('tie-break should not run');
      return text(RIGHT_PIPE);
    });
    const { chips, ui } = chipsUi();
    const r = await w.runTurn([], { text: PIPE_Q, images: [SHOT] }, ui);
    check('Pipeline bug: a checker that failed never overrides the right answer', /4\.1295/.test(r.text) && !/0\.9052/.test(r.text) && !r.corrected && !r.review, r.text);
    check('Pipeline bug: chip says the original was kept and why', /^Kept the original: the double-check didn't finish/.test(chips.find(c => c.n === 'verify')?.done || ''), chips.find(c => c.n === 'verify')?.done);
    check('Pipeline bug: no tie-break needed, outcome recorded', !reqs.some(isSolver) && r.trace.verification.outcome === 'checker-failed');
  }

  // ---------- 2. confident but wrong checker, same objective → code keeps the original ----------
  {
    const { w, reqs } = boot({ anthropicKey: 'k' }, b => {
      if (isChecker(b)) return text(setup('minimize ' + OBJ, 'x = 0.9052, y = 0.4352') + '\n<verdict>incorrect</verdict><proposed_values>x = 4.1295, y = 1.2572</proposed_values><final_answer>' + WRONG_PIPE_FINAL + '</final_answer><reason>The proposed x is too large.</reason>');
      if (isSolver(b)) throw new Error('tie-break should not run');
      return text(RIGHT_PIPE);
    });
    const { chips, ui } = chipsUi();
    const r = await w.runTurn([], { text: PIPE_Q, images: [SHOT] }, ui);
    const done = chips.find(c => c.n === 'verify')?.done || '';
    check('Confident wrong checker: cost compared by code, original kept', /4\.1295/.test(r.text) && !r.corrected && r.trace.verification.outcome === 'kept-by-evidence', JSON.stringify(r.trace.verification));
    check('Confident wrong checker: rejected because its answer isn\'t even a minimum of its own cost (code check)', /^Kept the original: the double-check's answer isn't the minimum of its own objective: moving [xy] to/.test(done) && r.trace.verification.checkerSelfCheck?.ok === false, done);
    check('Confident wrong checker: no third solve (saves budget)', !reqs.some(isSolver));
  }

  // ---------- 3. original really wrong, checker right with the same objective → replaced ----------
  {
    let calcOut = '';
    const { w, reqs } = boot({ anthropicKey: 'k' }, b => {
      if (isChecker(b)) {
        const tr = lastToolResult(b);
        if (!tr) return sseResponse(anthropicEvents([{ type: 'tool_use', id: 'k1', name: 'calculate', input: { lines: [`C(x, y) = ${OBJ}`, 'minimize(C(x, y), [x, y], [1, 1], [[0, 10], [0, 10]])'] } }], { stop: 'tool_use' }));
        calcOut = tr.content[0].text;
        return text(setup('minimize ' + OBJ, 'x = 4.1295, y = 1.2572') + '\n<verdict>incorrect</verdict><proposed_values>x = 0.9052, y = 0.4352</proposed_values><final_answer>**x ≈ 4.1295, y ≈ 1.2572**\n\n`4.1295, 1.2572`</final_answer><reason>The proposed point is not the minimum.</reason>');
      }
      if (isSolver(b)) throw new Error('tie-break should not run');
      return text(WRONG_PIPE);
    });
    const { chips, ui } = chipsUi();
    const r = await w.runTurn([], { text: PIPE_Q, images: [SHOT] }, ui);
    check('Real calculator minimizes the pipeline cost (x ≈ 4.1295, y ≈ 1.2572)', /x = 4\.12948\d*, y = 1\.25717/.test(calcOut), calcOut);
    check('Wrong original replaced, backed by the cost comparison', r.corrected && /4\.1295/.test(r.text) && r.review?.kind === 'corrected' && /449\.7254/.test(r.review.evidence) && /423\.5068/.test(r.review.evidence), JSON.stringify(r.review));
    check('Replaced answer keeps the original for the panel', /0\.9052/.test(r.review?.original || ''));
    check('Fixed chip shows the reason', /^Fixed: The proposed point is not the minimum/.test(chips.find(c => c.n === 'verify')?.done || ''));
    check('Checker runs on the smart model at high effort with only the calculator', (() => { const c = reqs.find(isChecker); return c.model === 'claude-sonnet-5-5' && c.tools.length === 1 && c.tools[0].name === 'calculate' && c.output_config?.effort === 'high'; })(), JSON.stringify(reqs.find(isChecker)?.output_config));
  }

  // ---------- 4. checker misread the problem (different objective) → tie-break on the strongest model ----------
  {
    const MISREAD = '40*sqrt(x^2 + 1) + 46*sqrt(y^2 + 4) + 36*(10 - x - y)';
    const { w, reqs } = boot({ anthropicKey: 'k' }, b => {
      if (isChecker(b)) return text(setup('minimize ' + MISREAD, 'x = 2.0647, y = 2.5145') + '\n<verdict>incorrect</verdict><proposed_values>x = 4.1295, y = 1.2572</proposed_values><final_answer>**x ≈ 2.0647, y ≈ 2.5145**</final_answer><reason>Different minimum.</reason>');
      if (isSolver(b)) return text(setup('minimize ' + OBJ, 'x = 4.1295, y = 1.2572') + '\n<final_answer>**x ≈ 4.1295, y ≈ 1.2572**</final_answer>');
      return text(RIGHT_PIPE);
    });
    const { chips, ui } = chipsUi();
    const r = await w.runTurn([], { text: PIPE_Q, images: [SHOT] }, ui);
    const solver = reqs.find(isSolver);
    check('Setups disagree → third solve runs on the strongest model (Opus)', solver?.model === 'claude-opus-5-5', solver?.model);
    check('Third solve never sees either earlier answer (no anchoring)', solver && !/0\.9052|4\.1295/.test(firstUserText(solver)) && /SCREENSHOT/.test(firstUserText(solver)));
    check('Third solve agrees with the original → original kept', !r.corrected && /4\.1295/.test(r.text) && r.trace.verification.outcome === 'kept-by-vote' && chips.find(c => c.n === 'tiebreak')?.done === 'Agrees with the original', r.trace.verification.outcome);
    check('Third solve is in the trace', r.trace.verification.tieBreak?.model === 'claude-opus-5-5');
  }

  // ---------- 5. cone: no numeric map → tie-break agrees with the checker → corrected by vote ----------
  {
    const { w } = boot({ anthropicKey: 'k' }, b => {
      if (isChecker(b)) return text('<verdict>incorrect</verdict><final_answer>' + RIGHT + '</final_answer><reason>The second point must be (3, 1, −√10), not (−3, −1, √10).</reason>');
      if (isSolver(b)) return text('<final_answer>$(3, 1, \\sqrt{10})$ and $(3, 1, -\\sqrt{10})$</final_answer>');
      return text(WRONG);
    });
    const { chips, ui } = chipsUi();
    const r = await w.runTurn([], { text: ASK, images: [SHOT] }, ui);
    check('Cone: 2 of 3 solves agree → corrected', r.corrected && r.text === RIGHT && r.review.kind === 'corrected' && r.review.original === WRONG, r.text);
    check('Cone: chip "Fixed" with reason', /^Fixed: The second point must be/.test(chips.find(c => c.n === 'verify')?.done || ''));
    check('Cone: tie-break chip shown', chips.find(c => c.n === 'tiebreak')?.done === 'Agrees with the double-check');
  }

  // ---------- 6. all three disagree → original kept, both alternatives shown with a warning ----------
  {
    const { w } = boot({ anthropicKey: 'k' }, b => {
      if (isChecker(b)) return text('<verdict>incorrect</verdict><final_answer>x = 7</final_answer><reason>Different root.</reason>');
      if (isSolver(b)) return text('<final_answer>**x = 9**</final_answer>');
      return text('x = 4');
    });
    const { chips, ui } = chipsUi();
    const r = await w.runTurn([], { text: 'solve x^3 - 2x = 56' }, ui);
    check('Conflict: original kept, both alternatives listed', r.text === 'x = 4' && !r.corrected && r.review?.kind === 'conflict' && r.review.alternatives.length === 2 && /x = 7/.test(r.review.alternatives[0].text) && /x = 9/.test(r.review.alternatives[1].text), JSON.stringify(r.review));
    check('Conflict: warning chip', /^Solves disagree/.test(chips.find(c => c.n === 'verify')?.done || ''));
  }

  // ---------- 7. verdicts ----------
  {
    const { w } = boot({ anthropicKey: 'k' }, b => isChecker(b) ? text('<verdict>correct</verdict><final_answer></final_answer><reason></reason>') : text('The derivative is $3x^2\\sin x + x^3\\cos x$.'));
    const { chips, ui } = chipsUi();
    const r = await w.runTurn([], { text: 'Find the derivative of x^3 sin(x)' }, ui);
    check('Correct answer kept and confirmed', !r.corrected && /3x\^2/.test(r.text) && chips.find(c => c.n === 'verify')?.done === 'Answer confirmed');
    const { w: w2 } = boot({ anthropicKey: 'k' }, b => isChecker(b) ? text('<verdict>unsure</verdict><final_answer>something else</final_answer><reason>Ambiguous problem statement.</reason>') : text('x = 4'));
    const r2 = await w2.runTurn([], { text: 'solve 2x + 3 = 11' }, { hasTab: false });
    check('"Unsure" never replaces the answer', r2.text === 'x = 4' && !r2.corrected && r2.trace.verification.verdict === 'unsure');
    check('Verdict parser: "not correct" is incorrect, never correct', w.parseVerdict('<verdict>not correct</verdict>') === 'incorrect' && w.parseVerdict('<verdict>Correct.</verdict>') === 'correct' && w.parseVerdict('<verdict>incorrect</verdict>') === 'incorrect' && w.parseVerdict('no tags') === 'unsure');
    const { w: w3, reqs: r3 } = boot({ anthropicKey: 'k' }, b => isChecker(b) ? text('<verdict>incorrect</verdict><final_answer>**x = 4.000**</final_answer><reason>Format.</reason>') : isSolver(b) ? text('nope') : text('x = 4'));
    const rr3 = await w3.runTurn([], { text: 'solve 2x + 3 = 11' }, { hasTab: false });
    check('Same values in another format: kept, no third solve', rr3.text === 'x = 4' && !rr3.corrected && !r3.some(isSolver) && rr3.trace.verification.outcome === 'same-answer', JSON.stringify(rr3.trace.verification));
  }

  // ---------- 8. when it does NOT run ----------
  {
    const { w, reqs } = boot({ anthropicKey: 'k' }, () => text('Paris is the capital, population about 2.1 million.'));
    await w.runTurn([], { text: "what's the capital of France?" }, { hasTab: false });
    await w.runTurn([], { text: 'Rewrite the selected text so it is clearer', quickAction: 'rewrite' }, { hasTab: false });
    check('Not for everyday questions or rewrites', !reqs.some(isChecker));
    const { w: w2, reqs: r2 } = boot({ anthropicKey: 'k', verifyAnswers: false }, () => text('x = 4'));
    await w2.runTurn([], { text: 'solve 2x + 3 = 11' }, { hasTab: false });
    check('Setting off: no double-check', !r2.some(isChecker));
    check('Gate: problem on screen / math words / plain chat', w.needsCheck({ route: { reason: 'chosen by you' }, userText: 'solve this', images: [SHOT], reply: 'x = 3' }) && w.needsCheck({ route: { reason: 'math or science' }, userText: 'integral of x', reply: '$x^2/2$' }) && !w.needsCheck({ route: { reason: 'everyday question' }, userText: 'tell me a joke', reply: 'Why did 2 cows…' }) && !w.needsCheck({ route: { reason: 'math or science' }, userText: 'what is calculus', reply: 'Calculus is the study of change.' }));
  }

  // ---------- 9. OpenAI path: tie-break on gpt-6-astra ----------
  {
    const { w, reqs } = boot({ openaiKey: 'k', provider: 'openai' }, b => {
      if (isChecker(b)) {
        if (!b.input.some(i => i.type === 'function_call_output')) return sseResponse(openaiEvents({ toolCall: { id: 'c1', name: 'calculate', args: { lines: ['solve(2x + 3 = 11, x)'] } } }));
        return sseResponse(openaiEvents({ text: '```setup\nvariables: x\ngoal: solve [2*x + 3 = 11]\nconstraints: none\nanswer: x = 4\n```\n<verdict>incorrect</verdict><proposed_values>x = 5</proposed_values><final_answer>**x = 4**</final_answer><reason>2x = 8.</reason>' }));
      }
      if (isSolver(b)) return sseResponse(openaiEvents({ text: '<final_answer>**x = 4**</final_answer>' }));
      return sseResponse(openaiEvents({ text: '**x = 5**' }));
    });
    const r = await w.runTurn([], { text: 'solve 2x + 3 = 11' }, { hasTab: false });
    const chk = reqs.filter(isChecker);
    check('OpenAI: checker uses the calculator', chk.length === 2 && /\{4\}/.test(chk[1].input.find(i => i.type === 'function_call_output').output));
    check('OpenAI: only the checker\'s setup → tie-break on gpt-6-astra → fixed by vote', r.text === '**x = 4**' && r.corrected && reqs.find(isSolver)?.model === 'gpt-6-astra', JSON.stringify([r.text, r.trace.verification.outcome, reqs.find(isSolver)?.model]));
  }

  // ---------- 10. the model gave up → the checker's clean solution replaces it ----------
  {
    const GIVE_UP = 'It seems there was a challenge solving this with exact methods due to the complexity. Given the complexity of exact computation, an approximation with a numerical tool or software would be ideal for precise results in such complex cases.';
    let calcOut = '';
    const { w, reqs } = boot({ anthropicKey: 'k' }, (b) => {
      const tr = lastToolResult(b);
      if (isChecker(b)) {
        if (!tr) return sseResponse(anthropicEvents([{ type: 'text', text: 'Cost C(x,y) = 40√(x²+4) + 46√(y²+1) + 36(10−x−y).' }, { type: 'tool_use', id: 'k1', name: 'calculate', input: { lines: ['C(x, y) = 40 sqrt(x^2 + 4) + 46 sqrt(y^2 + 1) + 36 (10 - x - y)', 'minimize(C(x, y), [x, y], [1, 1], [[0, 10], [0, 10]])'] } }], { stop: 'tool_use' }));
        calcOut = tr.content[0].text;
        const m = calcOut.match(/x = ([\d.]+), y = ([\d.]+)/);
        return text(`<verdict>incorrect</verdict><final_answer>**x ≈ ${(+m[1]).toFixed(4)} miles, y ≈ ${(+m[2]).toFixed(4)} miles**</final_answer><reason>The proposed answer gave up instead of solving numerically.</reason>`);
      }
      if (!tr) return sseResponse(anthropicEvents([{ type: 'tool_use', id: 'm1', name: 'calculate', input: { lines: ['solutions = solveSystem([40*x/sqrt(x^2 + 4) - 46*(10-x)/sqrt((10-x)^2+y^2) = 0, 46*y/sqrt((10-x)^2+y^2) = 0])', 'solutions'] } }], { stop: 'tool_use' }));
      return text(GIVE_UP);
    });
    const r = await w.runTurn([{ role: 'user', text: 'Solve this', images: [SHOT] }, { role: 'assistant', text: 'earlier attempt' }], { text: 'Try this again', images: [SHOT] }, { hasTab: false });
    check('Give-up reply triggers the double-check', reqs.some(isChecker) && w.needsCheck({ route: { reason: 'image' }, userText: 'Try this again', images: [SHOT], reply: GIVE_UP, usedCalc: true }));
    check('The give-up is replaced by the answer', r.corrected && /x ≈ 4\.1295 miles, y ≈ 1\.2572 miles/.test(r.text) && r.review?.kind === 'corrected', r.text);
    check('Prompt: never give up, numeric methods, write the model first, setup block', /Never give up and never tell them to use other software/.test(reqs[0].system) && /minimize\(f, \[x, y\]/.test(reqs[0].system) && /Write down the model/.test(reqs[0].system) && /```setup\nvariables:/.test(reqs[0].system) && /change only what you show, never how carefully you work/.test(reqs[0].system), reqs[0].system.slice(2000, 4500));
  }

  // ---------- 11. hold "just the answer" until the check is done; escalate screen math ----------
  {
    const { w, reqs } = boot({ anthropicKey: 'k', routing: 'fast' }, b => isChecker(b) ? text('<verdict>correct</verdict>') : text(RIGHT_PIPE));
    const streamed = []; let held = false;
    const r = await w.runTurn([], { text: PIPE_Q, images: [SHOT] }, { hasTab: false, tier: 'fast', onText: c => streamed.push(c), onHold: () => (held = true) });
    check('"Just an answer": nothing streams before the check, then the answer arrives', held && !streamed.length && r.held && /4\.1295/.test(r.text));
    check('Screenshot math escalates "fast" to the smart model at high effort', reqs[0].model === 'claude-sonnet-5-5' && reqs[0].output_config?.effort === 'high' && r.trace.route.reason === 'math on screen', JSON.stringify([reqs[0].model, reqs[0].output_config, r.trace.route]));
    const streamed2 = [];
    await w.runTurn([], { text: 'solve 2x + 3 = 11 and explain each step' }, { hasTab: false, onText: c => streamed2.push(c) });
    check('Normal requests still stream', streamed2.length > 0);
    check('"Just an answer" phrasing variants', w.JUST_ANSWER.test('give me just an answer') && w.JUST_ANSWER.test("i don't need the solution") && w.JUST_ANSWER.test('only the final answer pls') && !w.JUST_ANSWER.test('explain the answer'));
  }

  // ---------- 12. page text (including iframes) goes with the screenshot ----------
  {
    const frames = [
      { frameId: 0, result: { url: 'https://gettysburg.mrooms2.net/mod/lti/view.php?id=1', text: 'Moodle navigation Dashboard My courses MATH 211 '.repeat(5) } },
      { frameId: 7, result: { url: 'https://www.myopenmath.com/assess2/?cid=1', text: 'Question 10: A pipeline connects P to S. P is 2 miles above the line... cost $40 per mile, $46 per mile, $36 per mile. Find x and y.' } },
      { frameId: 8, result: { url: 'about:blank', text: '' } }
    ];
    let execArgs = null;
    const { w, reqs } = boot({ anthropicKey: 'k' }, b => isChecker(b) ? text('<verdict>correct</verdict>') : text(RIGHT_PIPE), {
      tabs: { query: async () => [{ id: 1, windowId: 1, url: 'https://gettysburg.mrooms2.net/mod/lti/view.php?id=1', title: 'HW 4.7' }] },
      scripting: { executeScript: async a => { execArgs = a; return frames; } }
    });
    await w.runTurn([], { text: PIPE_Q, images: [SHOT] }, { hasTab: true, screenFromTab: true });
    const main = JSON.stringify(reqs[0].messages.at(-1));
    const chk = JSON.stringify(reqs.find(isChecker).messages[0]);
    check('Reads text from all frames', execArgs?.target?.allFrames === true);
    check('Problem text (MyOpenMath iframe) sent first, fenced as untrusted', /untrusted_content/.test(main) && main.indexOf('Question 10') > -1 && main.indexOf('Question 10') < main.indexOf('Moodle navigation'), main.slice(0, 600));
    check('The checker gets the page text too', /Question 10: A pipeline/.test(chk));
    const { w: w2, reqs: r2 } = boot({ anthropicKey: 'k' }, () => text('ok'), { tabs: { query: async () => [] }, scripting: { executeScript: async () => { throw new Error('should not read'); } } });
    await w2.runTurn([], { text: 'hello there' }, { hasTab: true, screenFromTab: true });
    check('No page reading for non-math messages', !/untrusted_content/.test(JSON.stringify(r2[0].messages.at(-1))));
  }

  // ---------- 13. side panel ----------
  async function panel(responder) {
    const local = makeStore({ anthropicKey: 'k' });
    const html = fs.readFileSync(srcPath('sidepanel.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, '');
    const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://abc/sidepanel.html' }).window;
    H.basicDom(w);
    w.chrome = { storage: { local, session: makeStore(), onChanged: { addListener() {} } }, tabs: { query: async () => [{ id: 1, windowId: 1, url: 'https://gettysburg.mrooms2.net/mod/lti/view.php', title: 'Homework 4.7' }], captureVisibleTab: async () => SHOT }, scripting: { executeScript: async () => [] }, runtime: { getURL: p => p } };
    w.createImageBitmap = async () => ({ width: 800, height: 600 });
    w.fetch = async (u, o) => {
      if (String(u).startsWith('data:')) return { blob: async () => new w.Blob(['x'], { type: 'image/jpeg' }) };
      const b = JSON.parse(o.body);
      if (/You keep the pinned notes/.test(b.system)) return text('{"notes":[]}');
      return responder(b);
    };
    loadScripts(w, PANEL_SCRIPTS);
    await sleep(120);
    return { w, local, $: s => w.document.querySelector(s) };
  }
  async function ask(p, prompt, screen = true) {
    if (screen) p.$('#screenToggle').click();
    p.$('#input').value = prompt; p.$('#input').dispatchEvent(new p.w.Event('input')); p.$('#send').click();
    let sawThinkingHold = false, sawText = false;
    for (let i = 0; i < 400 && !p.$('.msg.ai .actions'); i++) {
      await sleep(15);
      if (/double-checking before showing/.test(p.$('.msg.ai .thinking')?.textContent || '')) sawThinkingHold = true;
      if (!p.$('.msg.ai .actions') && (p.$('.msg.ai > .md')?.textContent || '').trim()) sawText = true;
    }
    return { sawThinkingHold, sawText };
  }
  {
    const p = await panel(b => {
      if (isChecker(b)) return text('<verdict>incorrect</verdict><final_answer>' + RIGHT + '</final_answer><reason>The second point must be (3, 1, −√10).</reason>');
      if (isSolver(b)) return text('<final_answer>$(3, 1, \\sqrt{10})$ and $(3, 1, -\\sqrt{10})$</final_answer>');
      return sseResponse(anthropicEvents([{ type: 'text', text: WRONG }]), { delay: 2 });
    });
    const seen = await ask(p, ASK);
    const md = p.$('.msg.ai > .md').textContent;
    check('Panel: "just the answer" is held (status shown, no text until checked)', seen.sawThinkingHold && !seen.sawText, JSON.stringify(seen));
    check('Panel: corrected answer is the main answer', /3,1,sqrt\(10\)\), \(3,1,-sqrt\(10\)\)/.test(md) && !/-3, -1/.test(md), md);
    check('Panel: labeled "Correction after double-check"', /Correction after double-check/.test(p.$('.msg.ai > .review-label')?.textContent || ''));
    const orig = p.$('.msg.ai > .review-box details.review-alt');
    check('Panel: original kept, collapsed underneath', orig && !orig.open && /Original answer \(replaced\)/.test(orig.querySelector('summary').textContent) && /-3, -1/.test(orig.textContent));
    check('Panel: "Double-checked · Fixed" chip', /Double-checked/.test(p.$('.tool-chip.fixed')?.textContent) && /Fixed: The second point/.test(p.$('.tool-chip.fixed')?.textContent));
    const info = [...p.w.document.querySelectorAll('.act')].find(b => /Details/.test(b.title)); info.click();
    check('Panel: Details shows the outcome and the third solve', /Double-check \(claude-sonnet-5-5\): incorrect \(answer corrected\) · outcome: corrected/.test(p.$('.trace').textContent) && /Third solve \(claude-opus-5-5\)/.test(p.$('.trace').textContent), p.$('.trace').textContent.slice(0, 400));
    const [key, saved] = Object.entries(p.local.data()).find(([k]) => k.startsWith('chat:'));
    check('Saved chat keeps the corrected answer and the review', saved.messages[1].text === RIGHT && saved.messages[1].review?.kind === 'corrected' && saved.messages[1].review.original === WRONG);
    await p.w.openChat(key.slice(5));
    await sleep(30);
    check('Reopened chat shows the correction label and the collapsed original again', /Correction after double-check/.test(p.$('.msg.ai > .review-label')?.textContent || '') && /-3, -1/.test(p.$('.msg.ai > .review-box details.review-alt')?.textContent || ''));
  }
  {
    const p = await panel(b => {
      if (isChecker(b)) return text('<verdict>incorrect</verdict><final_answer>x = 7</final_answer><reason>Different root.</reason>');
      if (isSolver(b)) return text('<final_answer>**x = 9**</final_answer>');
      return sseResponse(anthropicEvents([{ type: 'text', text: 'x = 4\n\n' + setup('other', 'x = 4', 'none') }]), { delay: 2 });
    });
    const seen = await ask(p, 'Solve x^3 - 2x = 56, show your work', false);
    const box = p.$('.msg.ai > .review-box.conflict');
    check('Panel: normal math answers stream as usual', seen.sawText);
    check('Panel: disagreement shows a warning with both other answers', box && /Two solves disagree/.test(box.textContent) && box.querySelectorAll('details.review-alt').length === 2 && /x = 9/.test(box.textContent));
    check('Panel: warning chip', !!p.$('.tool-chip.warn'));
    const sb = p.$('.msg.ai > .md details.setup-block');
    check('Panel: setup block rendered collapsed as "How I set it up"', sb && !sb.open && /How I set it up/.test(sb.querySelector('summary').textContent) && /goal/i.test(sb.textContent) && /other/.test(sb.textContent) && /x = 4/.test(sb.textContent), p.$('.msg.ai > .md').innerHTML.slice(0, 500));
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
