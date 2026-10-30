// The math double-check: an independent re-solve, code that compares the answers, and a
// tie-break on the strongest model when that can't decide.
import type { Route, ToolTrace, ChatToolEnv, ChatToolResult, ReviewResult, Verification, Check } from "../types.js";
import { SMART_SIGNALS } from "../routing.js";
import { modelCall, type ModelMessage, type Tier, type ToolResult } from "../../core/llm/ai.js";
import { chatTools, realMemoryStore, executeChatTool, clip } from "../tools.js";
import { SETUP_FORMAT, parseVerdict, tagged, parseValues, parseSetup, stripSetup, answerValues, answersMatch, numbersIn } from "./parse.js";
import { calcEngine } from "../../core/calc/calc.js";
import { confirmAnswer, extremaProblem, arbitrate } from "./check.js";

// ---------- independent check of math answers ----------
// Reasoning models still slip (a sign, a missed candidate, a misread diagram). For math and
// homework-style questions a second pass re-solves the problem from scratch with the calculator.
// A model's "your answer is wrong" is not trusted on its own (research shows self-checks flip
// right answers to wrong ones): both solutions state their setup, and code compares them
// (objective value or equation residuals). If that can't decide, a third independent solve on
// the strongest model breaks the tie. If even that disagrees, both answers are shown.

export const SOLVE_WORDS = /\b(solve|answer|find|compute|calculate|evaluate|determine|derivative|integral|limit|prove|simplify|how (much|many|long|far)|probability|homework|exercise|problem|question)\b/i;

// Replies that don't actually answer ("an approximation with a numerical tool would be ideal").
export const GAVE_UP = /(would be ideal|use (a |an )?(numerical|graphing|computer|software|online|calculator|tool)|unable to (solve|compute|find)|can(no|')t (solve|compute|find|be solved)|too complex|beyond (my|the)|estimate the solution manually|encountered an error)/i;

// "Just give me the answer": the reply is held until the double-check finishes.
export const JUST_ANSWER = /\b(just|only)\s+(give\s+(me\s+)?)?(the\s+|an?\s+)?(final\s+)?answers?\b|\b(give|tell)\s+me\s+(just|only)\s+(the\s+|an?\s+)?(final\s+)?answers?\b|\bno\s+(explanation|solution|steps|work)\b|\b(don'?t|do not)\s+need\s+(the\s+|a\s+|any\s+)?(solution|explanation|steps|work)\b/i;

// A checker that failed or hedged ("no real solution was found", "a re-evaluation might be
// needed") never overrides an answer.
export const HEDGE = /\b(fail(ed|s|ure)?\b|unable\b|could ?n['o]?t\b|can(no|')t (compute|solve|find|determine|verify|confirm)|no (real |valid |consistent )?solutions? (was |were )?(found|exists?)|not (sure|certain|confident)|uncertain|unclear|might be (needed|wrong|required)|may be (needed|required)|re-?evaluat)/i;

export function isMathAsk({ route, userText, images = [], reply = "" }: { route: Route; userText: string; images?: string[]; reply?: string }) {
  const text = String(userText || "");
  const mathRoute = route.reason === "math or science" || route.reason === "math notation" || route.reason === "math on screen";
  const problemOnScreen = images.length > 0 && (SOLVE_WORDS.test(text) || (text.length < 120 && /\b(again|this|it|that|retry|redo)\b/i.test(text)));
  const mathyAsk = SOLVE_WORDS.test(text) && (SMART_SIGNALS[0][0].test(text + " " + reply) || SMART_SIGNALS[1][0].test(text + " " + reply));
  return { mathRoute, problemOnScreen, any: mathRoute || problemOnScreen || mathyAsk };
}

export function needsCheck({ route, userText, images = [], reply, usedCalc = false }: { route: Route; userText: string; images?: string[]; reply: string; usedCalc?: boolean }): boolean {
  if (!reply || reply.length > 8000) return false;
  if (!(isMathAsk({ route, userText, images, reply }).any || usedCalc)) return false;
  const numeric = /\d|\$|\\(frac|sqrt)|√/.test(reply);
  return numeric || GAVE_UP.test(reply);
}

// ---------- the solver loops (checker and tie-breaker) ----------

export function problemPrompt({ question, images, context = [], notes = [] }: { question: string; images: string[]; context?: ModelMessage[]; notes?: string[] }): string {
  const prior = context.slice(-4).map(m => `${m.role === "user" ? "User" : "Assistant"}: ${String((m as { text?: string }).text || "").slice(0, 1500)}`).join("\n\n");
  return `${prior ? `Earlier in the conversation (for context):\n${prior}\n\n` : ""}${notes.length ? `Pinned notes for this chat:\n${notes.map(n => `- ${n}`).join("\n")}\n\n` : ""}The user's request${images.length ? " (the problem may be in the attached image; any page text below is the same problem as text)" : ""}:
"""
${question}
"""`;
}

export async function solverLoop({ system, text, images = [], tier, model, signal, onThinking }: { system: string; text: string; images?: string[]; tier: Tier; model?: string; signal?: AbortSignal; onThinking?: (t: string) => void }): Promise<{ text: string; tools: ToolTrace[]; model: string }> {
  const calcTool = chatTools({ hasTab: false, hasAgent: false, webSearchServer: true }).filter(t => t.name === "calculate");
  const transcript: ModelMessage[] = [{ role: "user", images, text }];
  const env: ChatToolEnv = { memory: realMemoryStore, addCitations() {}, signal };
  const tools: ToolTrace[] = [];
  let out = "", model_ = model!;
  for (let round = 0; round < 8; round++) {
    if (round === 7) transcript.push({ role: "user", text: "(Stop calling tools now and give your final reply with the required block and tags.)" });
    const r = await modelCall({ tier, model, effort: "high", system, messages: transcript, tools: calcTool, signal, onThinking });
    out = r.text; model_ = r.model;
    if (!r.toolCalls.length || round === 7) break;
    transcript.push({ role: "assistant", text: r.text, toolCalls: r.toolCalls, raw: r.raw });
    const results: ToolResult[] = [];
    for (const call of r.toolCalls) {
      let res: ChatToolResult;
      try { res = await executeChatTool(call, env); } catch (err: any) { if (err.name === "AbortError") throw err; res = { text: `Error: ${err.message}`, isError: true }; }
      results.push({ id: call.id, name: call.name, text: res.text, isError: res.isError });
      tools.push({ name: call.name, args: call.args, result: clip(res.text, 1500), error: !!res.isError || (/✗/.test(res.text || "") && !/→/.test(res.text || "")) });
    }
    transcript.push({ role: "tool", results });
  }
  return { text: out, tools, model: model_ };
}

export async function verifyAnswer({ question, images = [], context = [], answer, notes = [], signal, onThinking }: { question: string; images?: string[]; context?: ModelMessage[]; answer: string; notes?: string[]; signal?: AbortSignal; onThinking?: (t: string) => void }) {
  const text = `${problemPrompt({ question, images, context, notes })}

Proposed answer:
"""
${answer}
"""

Solve the problem yourself from scratch, carefully, using the calculate tool for every computation (exact methods first; minimize, maximize, nsolve or nsolveSystem when exact ones fail). Don't trust the proposed answer. First write down the setup: what each variable means, the objective or equations, and the constraints. Find all solutions and check each against every condition in the problem. Then compare with the proposed answer.
Check that the proposed answer covers EVERY part asked (e.g. both maximum and minimum). For max/min with a constraint: Lagrange only gives candidates; if the constraint is unbounded, use scanCurve to see whether each extreme is actually reached. An extreme that's only approached is DNE, and giving the same value for max and min is wrong unless f is constant.
If the proposed answer doesn't actually give a final answer (it gives up, asks the user to use other software, or stops halfway), the verdict is incorrect and your final_answer must contain the full answer.
If your own computation failed or you couldn't finish, the verdict is unsure — never incorrect.

Finish with exactly these parts, in this order:
1. A setup block for YOUR solution, in calculate syntax, in exactly this format:
${SETUP_FORMAT}
2. <verdict>correct, incorrect, or unsure</verdict>
3. <proposed_values>The proposed answer's final values in the same "name = number" form as your answer line (e.g. x = 0.91, y = 0.44), or empty if it gave none.</proposed_values>
4. <final_answer>If incorrect: the complete corrected reply for the user, written in the same style and format the proposed answer used and following any format the user asked for (for example "just the answer"). Otherwise leave empty.</final_answer>
5. <reason>One short sentence: what was wrong, or why you're unsure.</reason>`;
  const system = "You are a meticulous checker of math and science answers. You independently re-solve the problem with exact computation and report whether a proposed answer is right. You never assume the proposed answer is correct, and you only call it incorrect when your own verified computation clearly shows a different result.";
  const r = await solverLoop({ system, text, images, tier: "smart", signal, onThinking });
  return {
    verdict: parseVerdict(r.text),
    finalAnswer: tagged(r.text, "final_answer"),
    reason: tagged(r.text, "reason"),
    proposedValues: parseValues(tagged(r.text, "proposed_values")),
    setup: parseSetup(r.text),
    tools: r.tools,
    model: r.model,
    calcFailed: r.tools.length > 0 && r.tools.at(-1)!.error
  };
}

// Third, independent solve on the strongest model. It never sees either earlier answer, so it
// can't be anchored by them.
export async function independentSolve({ question, images = [], context = [], notes = [], signal, onThinking }: { question: string; images?: string[]; context?: ModelMessage[]; notes?: string[]; signal?: AbortSignal; onThinking?: (t: string) => void }) {
  const text = `${problemPrompt({ question, images, context, notes })}

Solve this from scratch, carefully. First write down the setup: what each variable means (read every label, length and condition in the problem or image), the objective or equations, and the constraints. Answer every part asked. For max/min with a constraint, decide whether each extreme exists (closed and bounded → both exist; unbounded → check with scanCurve; only approached → DNE). Use the calculate tool for every computation (exact methods first; minimize, maximize, nsolve or nsolveSystem when exact ones fail). Check your answer against every condition.

Finish with exactly these parts:
1. A setup block, in calculate syntax, in exactly this format:
${SETUP_FORMAT}
2. <final_answer>The reply for the user, following any format they asked for (for example "just the answer"), with the final answer on its own line in bold.</final_answer>`;
  const system = "You are an expert, independent problem solver. You set problems up precisely, compute every step with the calculator, and verify your answer before replying.";
  const r = await solverLoop({ system, text, images, tier: "best", signal, onThinking });
  return { setup: parseSetup(r.text), finalAnswer: tagged(r.text, "final_answer") || stripSetup(r.text), tools: r.tools, model: r.model };
}

// Runs the double-check (and the tie-break when needed) and decides what the user sees.
// Returns { text, review?, verification, chip }.
export async function reviewAnswer({ text, question, images, context, notes, signal, onTieBreak, onThinking }: { text: string; question: string; images: string[]; context: ModelMessage[]; notes: string[]; signal?: AbortSignal; onTieBreak?: () => void; onThinking?: (t: string, label?: string) => void }): Promise<ReviewResult> {
  await calcEngine.load(); // math.js is needed to compare answers
  const v = await verifyAnswer({ question, images, context, notes, answer: text, signal, onThinking: t => onThinking?.(t, "Double-check") });
  const verification: Verification = { verdict: v.verdict, reason: v.reason, tools: v.tools, model: v.model };
  const pSetup = parseSetup(text);
  const pValues = pSetup?.values || v.proposedValues || answerValues(text);
  const pConf = await confirmAnswer(pSetup, pValues);
  verification.selfCheck = pConf.ok === null ? undefined : pConf;
  // The checker agreed, but the answer is incomplete in a way code can spot: get a third opinion.
  const incomplete = v.verdict !== "incorrect" ? extremaProblem(question, text) : "";
  if (incomplete) {
    onTieBreak?.();
    const tb = await independentSolve({ question, images, context, notes, signal, onThinking: t => onThinking?.(t, "Third solve") }).catch(err => { if (err.name === "AbortError") throw err; return null; });
    verification.tieBreak = tb && { model: tb.model, answer: clip(tb.finalAnswer, 600), tools: tb.tools };
    if (tb && tb.finalAnswer && !extremaProblem(question, tb.finalAnswer) && !answersMatch({ text: stripSetup(tb.finalAnswer) }, { text: stripSetup(text) }, question)) {
      return {
        text: tb.finalAnswer,
        review: { kind: "corrected", original: text, reason: incomplete, evidence: `a third solve (${tb.model}) gave a complete answer`, by: "completeness" },
        verification: { ...verification, outcome: "corrected", corrected: true, evidence: incomplete },
        chip: { fixed: `Fixed: ${incomplete}` }
      };
    }
    return {
      text,
      review: { kind: "conflict", reason: incomplete, alternatives: tb ? [{ label: `Third solve (${tb.model}) got`, text: tb.finalAnswer }] : [] },
      verification: { ...verification, outcome: "unconfirmed" },
      chip: { warn: `Solves disagree — ${incomplete}` }
    };
  }
  if (v.verdict === "correct" && pConf.ok === false) {
    // The checker agreed, but the code says the answer fails its own setup: get a third opinion.
    onTieBreak?.();
    const tb = await independentSolve({ question, images, context, notes, signal, onThinking: t => onThinking?.(t, "Third solve") }).catch(err => { if (err.name === "AbortError") throw err; return null; });
    verification.tieBreak = tb && { model: tb.model, answer: clip(tb.finalAnswer, 600), tools: tb.tools };
    const third = tb && { values: tb.setup?.values || answerValues(tb.finalAnswer), text: stripSetup(tb.finalAnswer) };
    const tConf: Check = tb ? await confirmAnswer(tb.setup, third!.values) : { ok: null, evidence: "" };
    if (third && tConf.ok === true && !answersMatch(third, { values: pValues, text: stripSetup(text) }, question)) {
      return {
        text: tb.finalAnswer,
        review: { kind: "corrected", original: text, reason: pConf.evidence, evidence: `a third solve (${tb.model}) found an answer that passes its check`, by: "self-check" },
        verification: { ...verification, outcome: "corrected", corrected: true, evidence: pConf.evidence },
        chip: { fixed: `Fixed: ${pConf.evidence}` }
      };
    }
    return {
      text,
      review: { kind: "conflict", reason: pConf.evidence, alternatives: tb ? [{ label: `Third solve (${tb.model}) got`, text: tb.finalAnswer }] : [] },
      verification: { ...verification, outcome: "unconfirmed" },
      chip: { warn: `Solves disagree — the code check says ${pConf.evidence}` }
    };
  }
  if (v.verdict === "correct") return { text, verification: { ...verification, outcome: "confirmed" }, chip: { ok: pConf.ok ? "Answer confirmed · code check passed" : "Answer confirmed" } };
  if (v.verdict !== "incorrect" || !v.finalAnswer) {
    return { text, verification: { ...verification, outcome: "unconfirmed" }, chip: { ok: v.reason ? `Couldn't fully confirm: ${v.reason}` : "Couldn't fully confirm" } };
  }

  // The checker says "incorrect". Was its own work sound?
  if (HEDGE.test(v.reason) || v.calcFailed || GAVE_UP.test(v.finalAnswer)) {
    return {
      text,
      verification: { ...verification, outcome: "checker-failed" },
      chip: { ok: `Kept the original: the double-check didn't finish its own solution${v.reason ? ` (${clip(v.reason, 80)})` : ""}` }
    };
  }

  const original = { values: pValues, text: stripSetup(text) };
  const checker = { values: v.setup?.values || answerValues(v.finalAnswer), text: stripSetup(v.finalAnswer) };
  const replaceWith = (evidence: string, by: string): ReviewResult => ({
    text: v.finalAnswer,
    review: { kind: "corrected", original: text, reason: v.reason, evidence, by },
    verification: { ...verification, outcome: "corrected", corrected: true, evidence },
    chip: { fixed: `Fixed: ${v.reason || evidence}` }
  });

  // An original that never answered can be replaced by any clean solution.
  if (GAVE_UP.test(text) || !numbersIn(text).length) return replaceWith("the first answer didn't finish", "double-check");
  // Same final values: the checker only quibbled about wording or format.
  if (answersMatch(original, checker, question)) return { text, verification: { ...verification, outcome: "same-answer" }, chip: { ok: "Answer confirmed (same values)" } };

  // The checker's answer fails its own setup's check (e.g. it isn't even a minimum of its own
  // cost function): it can't overturn anything.
  const cConf = await confirmAnswer(v.setup, checker.values);
  verification.checkerSelfCheck = cConf.ok === null ? undefined : cConf;
  if (cConf.ok === false) return { text, verification: { ...verification, outcome: "kept-by-evidence", evidence: cConf.evidence }, chip: { ok: `Kept the original: the double-check's answer ${cConf.evidence.replace(/^\([^)]*\) /, "")}` } };

  const a = await arbitrate({ pSetup, cSetup: v.setup, pValues: original.values, cValues: checker.values });
  verification.arbitration = a;
  if (a.decision === "keep") return { text, verification: { ...verification, outcome: "kept-by-evidence", evidence: a.evidence }, chip: { ok: `Kept the original: ${a.evidence}` } };
  if (a.decision === "replace") return replaceWith(a.evidence, "calculation");

  // Undecided: a third, independent solve on the strongest model.
  onTieBreak?.();
  let tb: Awaited<ReturnType<typeof independentSolve>> | null;
  try {
    tb = await independentSolve({ question, images, context, notes, signal, onThinking: t => onThinking?.(t, "Third solve") });
  } catch (err: any) {
    if (err.name === "AbortError") throw err;
    tb = null;
  }
  verification.tieBreak = tb && { model: tb.model, answer: clip(tb.finalAnswer, 600), tools: tb.tools };
  const third = tb && { values: tb.setup?.values || answerValues(tb.finalAnswer), text: stripSetup(tb.finalAnswer) };
  // Only answers that don't fail their own code check get a vote.
  const tConf: Check = tb ? await confirmAnswer(tb.setup, third!.values) : { ok: null, evidence: "" };
  const thirdCounts = third && tConf.ok !== false;
  const withP = thirdCounts && pConf.ok !== false && answersMatch(third, original, question);
  const withC = thirdCounts && answersMatch(third, checker, question);
  verification.vote = { original: pConf.ok, doubleCheck: cConf.ok, third: tConf.ok };
  if (withP && !withC) return { text, verification: { ...verification, outcome: "kept-by-vote" }, chip: { ok: "Kept the original: a third independent solve agrees with it" } };
  if (withC && !withP) return replaceWith(`a third independent solve (${tb!.model}) agrees with the double-check`, "vote");
  return {
    text,
    review: {
      kind: "conflict",
      reason: v.reason,
      alternatives: [
        { label: "Double-check got", text: v.finalAnswer },
        ...(tb ? [{ label: `Third solve (${tb.model}) got`, text: tb.finalAnswer }] : [])
      ]
    },
    verification: { ...verification, outcome: "conflict" },
    chip: { warn: "Solves disagree — check before submitting" }
  };
}
