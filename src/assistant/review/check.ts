// Deciding with code, not with a model's opinion: objectives, constraints and residuals.
import type { Values, Setup, Arbitration, Check } from "../types.js";
import { calcEngine } from "../../core/calc/calc.js";
import { close, fmtPoint, fmtNum, stripSetup } from "./parse.js";

// ---------- deciding with code, not with a model's opinion ----------

export async function evalSafe(expr: string, values: Values): Promise<any> {
  try {
    const v = await calcEngine.evaluate(expr, values);
    return typeof v === "number" && !Number.isFinite(v) ? NaN : v;
  } catch { return NaN; }
}

export async function feasible(constraints: string[], values: Values): Promise<boolean> {
  for (const c of constraints) {
    const ok = await evalSafe(c, values);
    if (ok === false) return false;
  }
  return true;
}

export async function residualsOk(equations: string[], values: Values): Promise<boolean | null> {
  for (const eq of equations) {
    const r = await evalSafe(eq, values);
    if (typeof r === "boolean") { if (!r) return false; continue; } // a condition like x > 0
    if (typeof r !== "number" || Number.isNaN(r)) return null; // can't evaluate → unknown
    const scale = Math.max(1, ...Object.values(values).map(Math.abs));
    if (Math.abs(r) > 5e-3 * scale) return false;
  }
  return true;
}

// Compares the original answer (p) with the checker's (c).
// Returns { decision: "keep" | "replace" | "undecided", evidence }.
// "replace" needs decisive evidence under BOTH setups (or a setup they agree on); a checker's
// own setup alone can only confirm the original, never overturn it.
export async function arbitrate({ pSetup, cSetup, pValues, cValues }: { pSetup: Setup | null; cSetup: Setup | null; pValues?: Values | null; cValues?: Values | null }): Promise<Arbitration> {
  const setups = [pSetup, cSetup].filter((st): st is Setup => !!st && st.type !== "other");
  if (!pValues || !cValues || !setups.length) return { decision: "undecided", evidence: "no comparable numeric answers" };
  const keys = Object.keys(pValues).sort().join();
  if (keys !== Object.keys(cValues).sort().join()) return { decision: "undecided", evidence: "the answers use different variables" };
  const both = !!(pSetup && cSetup && pSetup.type !== "other" && cSetup.type !== "other");

  // Optimization: evaluate every stated objective at both answers.
  const opt = setups.filter(st => (st.type === "min" || st.type === "max") && st.objective);
  if (opt.length && opt.every(st => st.type === opt[0].type)) {
    const vals: { p: any; c: any }[] = [];
    for (const st of opt) vals.push({ p: await evalSafe(st.objective!, pValues), c: await evalSafe(st.objective!, cValues) });
    if (vals.every(v => typeof v.p === "number" && typeof v.c === "number" && !Number.isNaN(v.p) && !Number.isNaN(v.c))) {
      // Two setups only count as one model if they give the same objective values at both points.
      const agree = vals.every(v => close(v.p, vals[0].p, 1e-6) && close(v.c, vals[0].c, 1e-6));
      const constraints = setups.flatMap(st => st.constraints || []);
      const fp = vals[0].p, fc = vals[0].c;
      const feasP = await feasible(constraints, pValues), feasC = await feasible(constraints, cValues);
      const sign = opt[0].type === "min" ? 1 : -1;
      const tol = 1e-6 * Math.max(1, Math.abs(fp));
      const cBetter = feasC && (!feasP || sign * (fc - fp) < -tol);
      const pAsGood = feasP && (!feasC || sign * (fp - fc) <= tol);
      const name = opt[0].type === "min" ? "lower" : "higher";
      const evidence = `objective at the original (${fmtPoint(pValues)}) = ${fmtNum(fp)}${feasP ? "" : " (breaks a constraint)"}; at the double-check's (${fmtPoint(cValues)}) = ${fmtNum(fc)}${feasC ? "" : " (breaks a constraint)"}`;
      if (pAsGood && agree) return { decision: "keep", evidence: `${evidence}. The original is as good or ${name}.` };
      if (cBetter && agree && (both || opt.length > 1)) return { decision: "replace", evidence: `${evidence}. The double-check's is ${name}.` };
      return { decision: "undecided", evidence: agree ? `${evidence}, but only the double-check's own setup says so` : "the two setups disagree (different objectives)" };
    }
    return { decision: "undecided", evidence: "couldn't evaluate the objective at both answers" };
  }

  // Equations: plug both answers into every stated system.
  const systems = setups.filter(st => st.type === "equations" && st.equations?.length);
  if (systems.length) {
    const eqs = systems.flatMap(st => st.equations!);
    const pOk = await residualsOk(eqs, pValues), cOk = await residualsOk(eqs, cValues);
    if (pOk === true) return { decision: "keep", evidence: `the original (${fmtPoint(pValues)}) satisfies the equations` };
    if (pOk === false && cOk === true && both) return { decision: "replace", evidence: `the original (${fmtPoint(pValues)}) doesn't satisfy the equations; the double-check's (${fmtPoint(cValues)}) does` };
    return { decision: "undecided", evidence: "plugging in didn't settle it" };
  }
  return { decision: "undecided", evidence: "no objective or equations to compare" };
}

// Does an answer pass its OWN setup's check? For optimization: it's feasible and no small step
// in any variable makes the objective better (a real local optimum). For equations: plugging it
// in works. Returns { ok: true | false | null (can't tell), evidence }.
export async function confirmAnswer(setup: Setup | null | undefined, values: Values | null | undefined): Promise<Check> {
  if (!setup || !values || setup.type === "other") return { ok: null, evidence: "" };
  const vars = Object.keys(values);
  if (setup.type === "equations") {
    const ok = await residualsOk(setup.equations || [], values);
    return ok === null ? { ok: null, evidence: "" } : { ok, evidence: ok ? "satisfies its equations" : `(${fmtPoint(values)}) doesn't satisfy its own equations` };
  }
  if (!setup.objective) return { ok: null, evidence: "" };
  const f = await evalSafe(setup.objective, values);
  if (typeof f !== "number" || Number.isNaN(f)) return { ok: null, evidence: "" };
  if (!(await feasible(setup.constraints || [], values))) return { ok: false, evidence: `(${fmtPoint(values)}) breaks its own constraints` };
  const sign = setup.type === "min" ? 1 : -1;
  // Steps big enough that rounding (to 4 or even 2 decimals) can't fake an improvement.
  for (const v of vars) {
    for (const dir of [1, -1]) {
      const h = 0.02 * Math.max(1, Math.abs(values[v]));
      const p = { ...values, [v]: values[v] + dir * h };
      if (!(await feasible(setup.constraints || [], p))) continue;
      const g = await evalSafe(setup.objective, p);
      if (typeof g === "number" && !Number.isNaN(g) && sign * (g - f) < -1e-9 * Math.max(1, Math.abs(f))) {
        return { ok: false, evidence: `(${fmtPoint(values)}) isn't the ${setup.type === "min" ? "minimum" : "maximum"} of its own objective: moving ${v} to ${fmtNum(p[v])} gives ${fmtNum(g)} instead of ${fmtNum(f)}` };
      }
    }
  }
  return { ok: true, evidence: `(${fmtPoint(values)}) is a local ${setup.type === "min" ? "minimum" : "maximum"} of its own objective` };
}

// A question asking for both the maximum and the minimum, answered with the same value for both
// (or only one of them, with no DNE) is almost always a Lagrange candidate reported twice.
// Returns a reason string, or "".
export function extremaProblem(question: string, answer: string): string {
  const q = String(question || ""), a = stripSetup(answer).replace(/[*$`\\]/g, " ");
  if (!/\bmax(imum|ima)?\b[\s\S]*\bmin(imum|ima)?\b|\bmin(imum|ima)?\b[\s\S]*\bmax(imum|ima)?\b/i.test(q)) return "";
  if (/\bDNE\b|does not exist|doesn['’]t exist|not attained|no (maximum|minimum)/i.test(a)) return "";
  const num = (re: RegExp) => { const m = a.match(re); return m ? Number(m[1].replace(/[−–]/g, "-")) : null; };
  const mx = num(/\bmax(?:imum)?(?:\s+value)?\b[^0-9−–-]{0,25}([−–-]?\d+(?:\.\d+)?)/i);
  const mn = num(/\bmin(?:imum)?(?:\s+value)?\b[^0-9−–-]{0,25}([−–-]?\d+(?:\.\d+)?)/i);
  if (mx !== null && mn !== null && close(mx, mn, 1e-9)) return `the answer gives the same value (${fmtNum(mx)}) for the maximum and the minimum; one of them probably doesn't exist (DNE)`;
  if (/\bboth\b[^.\n]{0,40}?[−–-]?\d/i.test(a) || (/\bboth\b/i.test(a) && (mx !== null || mn !== null))) return "the answer says the maximum and minimum are both the same value; one of them probably doesn't exist (DNE)";
  if ((mx === null) !== (mn === null)) return `the question asks for the maximum and the minimum, but the answer only gives the ${mx === null ? "minimum" : "maximum"}`;
  return "";
}
