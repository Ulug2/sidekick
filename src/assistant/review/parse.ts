// Reading answers: setup blocks, tagged parts of a checker's reply, final values and points.
import type { Values, Setup, Answer } from "../types.js";
import { calcEngine } from "../../core/calc/calc.js";

export function tagged(text: string, tag: string): string {
  const m = String(text).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}

// Exact verdict word: "incorrect" or "not correct" must never read as "correct".
export function parseVerdict(text: string): "correct" | "incorrect" | "unsure" {
  const v = tagged(text, "verdict").toLowerCase().replace(/[^a-z ]/g, " ").trim();
  if (/\b(incorrect|wrong|not correct)\b/.test(v)) return "incorrect";
  if (/\b(unsure|uncertain|unknown|not sure)\b/.test(v)) return "unsure";
  if (/^correct\b/.test(v) || v === "correct") return "correct";
  return "unsure";
}

// ---------- setup blocks ----------
// Every math answer ends with a machine-readable block (the panel shows it collapsed):
// ```setup
// variables: x = horizontal run P→Q (miles), y = horizontal run Q→R (miles)
// goal: minimize 40*sqrt(x^2 + 4) + 46*sqrt(y^2 + 1) + 36*(10 - x - y)
// constraints: 0 <= x <= 10, 0 <= y <= 10, x + y <= 10
// answer: x = 4.1295, y = 1.2572
// ```

export const SETUP_FORMAT = "```setup\nvariables: x = what x means (units), y = …\ngoal: minimize <objective> | maximize <objective> | solve [equation 1, equation 2] | other\nconstraints: 0 <= x <= 10, … (or none)\nanswer: x = 2.5, y = 0.75\n```";

export function splitTop(s: unknown): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const c of String(s || "")) {
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if ((c === "," || c === ";") && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// "x = 4.1295, y ≈ 1.2572" → { x: 4.1295, y: 1.2572 }. Null when a name repeats (several solutions).
export function parseValues(text: unknown): Values | null {
  const vals: Values = {};
  for (const m of String(text || "").replace(/[−–]/g, "-").matchAll(/(?:^|[^\w.])([A-Za-z][A-Za-z0-9_]*)\s*(?:=|≈|\\approx)\s*\$?\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)/g)) {
    if (m[1] in vals) return null;
    vals[m[1]] = Number(m[2]);
  }
  return Object.keys(vals).length ? vals : null;
}

export function stripSetup(text: unknown): string {
  return String(text || "").replace(/```setup[\s\S]*?(```|$)/gi, "").trim();
}

export function parseSetup(text: unknown): Setup | null {
  const blocks = [...String(text || "").matchAll(/```setup[^\n]*\n([\s\S]*?)```/gi)];
  if (!blocks.length) return null;
  const body = blocks.at(-1)![1];
  const field = (k: string) => ((body.match(new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, "im")) || [])[1] || "").trim();
  const goal = field("goal");
  const constraints = field("constraints");
  const setup: Setup = {
    raw: body.trim(),
    variables: field("variables"),
    constraints: /^(none|n\/a|-)?$/i.test(constraints) ? [] : splitTop(constraints),
    answerText: field("answer"),
    type: "other",
    values: null
  };
  let m;
  if ((m = goal.match(/^(minimi[sz]e|maximi[sz]e|min|max)\b\s*:?\s*(.+)$/i))) {
    setup.type = /^min/i.test(m[1]) ? "min" : "max";
    setup.objective = m[2].replace(/^[A-Za-z]\w*\s*(\([^)]*\))?\s*=(?!=)\s*/, "").trim();
  } else if ((m = goal.match(/^solve\b\s*:?\s*(.+)$/i))) {
    setup.type = "equations";
    setup.equations = splitTop(m[1].trim().replace(/^\[([\s\S]*)\]$/, "$1"));
  }
  setup.values = parseValues(setup.answerText);
  return setup;
}

// The final numbers of a reply when it has no setup block: look at its last lines only, so
// intermediate values in the working don't count.
export function answerValues(text: string): Values | null {
  const lines = stripSetup(text).split("\n").map(l => l.trim()).filter(Boolean);
  for (let k = 1; k <= Math.min(4, lines.length); k++) {
    const v = parseValues(lines.slice(-k).join("\n"));
    if (v) return v;
  }
  return null;
}

export const close = (a: number, b: number, rel = 5e-3) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

export function numbersIn(text: string): number[] {
  return (stripSetup(text).replace(/[−–]/g, "-").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}
export const plain = (t: string) => stripSetup(t).replace(/[\s$*`\\{}]/g, "").replace(/[−–]/g, "-").toLowerCase();

// LaTeX-ish math → something math.js can evaluate: \sqrt{10} → sqrt(10), \frac{a}{b} → (a)/(b).
export function delatex(t: string): string {
  let s = String(t).replace(/\$/g, "").replace(/\\left|\\right|\\,|\\!/g, "").replace(/\\cdot|\\times/g, "*").replace(/\\pi/g, "pi");
  for (let k = 0; k < 4; k++) s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "(($1)/($2))").replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)");
  return calcEngine.normalize ? calcEngine.normalize(s) : s;
}
export const numKey = (v: number) => (Math.abs(v) < 1e-9 ? "0" : Number(v.toPrecision(3)).toString());
export function evalNum(expr: string): number | null {
  try {
    const v = window.math.evaluate(expr);
    const n = typeof v === "number" ? v : v && typeof v.re === "number" && Math.abs(v.im || 0) < 1e-12 ? v.re : NaN;
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
// Points and tuples in an answer, e.g. "(3, 1, \sqrt{10}) and (3, 1, -\sqrt{10})" → {"3,1,3.16", "3,1,-3.16"}.
export function tuplesIn(text: string): Set<string> {
  const set = new Set<string>();
  if (!window.math) return set;
  const s = delatex(stripSetup(text));
  for (const m of s.matchAll(/\(((?:[^()]|\([^()]*\))*)\)/g)) {
    const parts = splitTop(m[1]);
    if (parts.length < 2) continue;
    const vals = parts.map(evalNum);
    if (vals.every(v => v !== null)) set.add((vals as number[]).map(numKey).join(","));
  }
  return set;
}

// Do two final answers say the same thing? Values by name, else the same points, else the
// same short list of numbers, else the same text. Points that only restate the question
// (like the given point (6, 2, 0)) don't count.
export function answersMatch(a: Answer, b: Answer, question = ""): boolean {
  if (!a || !b) return false;
  if (a.values && b.values) {
    const ka = Object.keys(a.values).sort(), kb = Object.keys(b.values).sort();
    if (ka.join() === kb.join()) return ka.every(k => close(a.values![k], b.values![k]));
  }
  const given = tuplesIn(question);
  const ta = [...tuplesIn(a.text)].filter(t => !given.has(t)), tb = [...tuplesIn(b.text)].filter(t => !given.has(t));
  if (ta.length && tb.length) return ta.length === new Set([...ta, ...tb]).size && tb.length === ta.length;
  const sa = stripSetup(a.text), sb = stripSetup(b.text);
  if (sa.length < 400 && sb.length < 400) {
    const na = new Set(numbersIn(sa).map(numKey)), nb = new Set(numbersIn(sb).map(numKey));
    if (na.size && na.size === nb.size && [...na].every(x => nb.has(x))) return true;
    if (na.size && nb.size) return false;
  }
  return !!a.text && plain(a.text) === plain(b.text);
}

export const fmtNum = (v: unknown): string => (typeof v === "number" ? (Math.abs(v) >= 1e4 || Math.abs(v) < 1e-3 ? v.toPrecision(6) : String(+v.toFixed(4))) : String(v));
export const fmtPoint = (vals: Values) => Object.entries(vals).map(([k, v]) => `${k} = ${fmtNum(v)}`).join(", ");
