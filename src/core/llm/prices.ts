// What model calls cost, in US dollars per million tokens: Anthropic's list prices (checked
// 2026-10-31) and OpenAI's GPT-5.6 prices after the July 30, 2026 cut (checked 2026-11-01). A model
// that isn't listed has no price: its cost is shown as unknown, never guessed (gpt-6-astra isn't
// listed yet).
import type { Usage } from "./types.js";

export interface Price { input: number; output: number; cacheRead: number; cacheWrite: number }
// long: a higher price for the whole call once the prompt is longer than `over` tokens.
export const PRICES: Record<string, Price & { long?: Price & { over: number } }> = {
  // Haiku's cache prices follow the usual rule (reads 0.1×, 5-minute writes 1.25× the input price).
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, long: { over: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }, // the "deep" role (models.ts); checked 2026-11-10
  // OpenAI bills cached input at 0.1× and no cache writes (usage.input excludes cached tokens).
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 }
};

// Dollars for one call, or null when the model has no price.
export function costOf(model: string, u: Usage | undefined): number | null {
  const p = PRICES[model];
  if (!p) return null;
  if (!u) return 0;
  const prompt = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
  const r = p.long && prompt > p.long.over ? p.long : p;
  return ((u.input || 0) * r.input + (u.output || 0) * r.output + (u.cacheRead || 0) * r.cacheRead + (u.cacheWrite || 0) * r.cacheWrite) / 1e6;
}

export const formatCost = (usd: number | null | undefined): string =>
  usd == null ? "unknown" : usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
