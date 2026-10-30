// Routing (cost + quality): the cheap fast model for everyday messages, the smart model for
// anything that needs real reasoning. Local heuristics, so routing itself costs nothing.
import type { Tier } from "../core/llm/ai.js";
import type { Route } from "./types.js";

// ---------- routing (cost + quality) ----------
// Cheap fast model for everyday messages; the smart model for anything that needs real
// reasoning. Local heuristics, so routing itself costs nothing.

export const SMART_SIGNALS: [RegExp, string][] = [
  [/\b(derivative|differentiat|integra(l|te)|limit|solve|equation|proof|prove|theorem|lemma|matrix|matrices|eigen|determinant|probabilit|statistic|variance|regression|calculus|differential|optimi[sz]|discriminant|gradient|hessian|series|converge|critical point|extrema|maxim|minim|polynomial|logarithm|trig|vector|physics|chemistry)\w*/i, "math or science"],
  [/[∫∑∏√π≤≥≠∞∂Δ]|\\(frac|int|sum|lim|sqrt)|\b[a-z]\s*\^\s*\d|\d\s*[\+\-\*\/\^]\s*\d|\bf\s*\(\s*x/i, "math notation"],
  [/```|\b(function|class|def|const|import|SELECT|typescript|javascript|python|java|c\+\+|sql|regex|algorithm|big[- ]?o|complexity|stack ?trace|exception|segfault|compile|refactor|debug)\b/i, "code"],
  [/\b(why|explain|analy[sz]e|compare|trade-?offs?|plan|strategy|step[- ]by[- ]step|pros and cons|evaluate|design|review|critique|recommend|decide|which should)\b/i, "reasoning"]
];
export const FAST_ONLY = /^(hi|hey|hello|yo|thanks?|thank you|thx|ok(ay)?|cool|nice|great|good (morning|afternoon|evening|night)|bye|lol|haha)[\s!.?]*$/i;

export function routeMessage(text: string, { attachments = [], previousTier, quickAction }: { attachments?: { kind: string }[]; previousTier?: Tier | null; quickAction?: string } = {}): Route {
  const t = String(text || "").trim();
  if (FAST_ONLY.test(t)) return { tier: "fast", reason: "small talk" };
  if (quickAction && ["rewrite", "shorten", "grammar"].includes(quickAction)) return { tier: "fast", reason: "text edit" };
  for (const [re, why] of SMART_SIGNALS) if (re.test(t)) return { tier: "smart", reason: why };
  if (attachments.some(a => a.kind === "image")) return { tier: "smart", reason: "image" };
  if (attachments.some(a => a.kind === "page" || a.kind === "file")) return { tier: "smart", reason: "long document" };
  if (t.length > 500) return { tier: "smart", reason: "long message" };
  if (previousTier === "smart" && t.length < 140) return { tier: "smart", reason: "follow-up" };
  return { tier: "fast", reason: "everyday question" };
}
