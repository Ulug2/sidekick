// The spend cap: dollars per day and per month from the usage log (tokens per model per day, priced
// by prices.ts). modelCall asks before every request; over a cap it refuses with SpendCapError, so
// every worker stops at a step boundary and the orchestrator pauses (never mid-submit).
import { costOf, PRICES } from "./prices.js";
import type { UsageLog } from "./usage.js";
import { readLocal } from "../storage/schema.js";

export const DEFAULT_CAPS = { daily: 1, monthly: 25 }; // dollars; Settings → Spend
export interface Spend { today: number; month: number; unpriced: string[] }

const dayKey = (d: Date) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
// Dollars spent today and this month (models without a price are listed, never guessed).
export function spendFor(usage: UsageLog | undefined, now = new Date()): Spend {
  const today = dayKey(now), month = today.slice(0, 7);
  const out: Spend = { today: 0, month: 0, unpriced: [] };
  const unpriced = new Set<string>();
  for (const [day, models] of Object.entries(usage || {})) {
    if (!day.startsWith(month)) continue;
    for (const [model, u] of Object.entries(models)) {
      let c = costOf(model, u);
      // A model without a price still counts against the cap, at the most expensive known price
      // (fail closed: an unpriced model must not spend around the cap).
      if (c == null) { unpriced.add(model); c = worstCase(u); }
      out.month += c;
      if (day === today) out.today += c;
    }
  }
  out.unpriced = [...unpriced];
  return out;
}

function worstCase(u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): number {
  const p = Object.values(PRICES);
  const max = (k: "input" | "output" | "cacheRead" | "cacheWrite") => Math.max(...p.map(x => x[k]));
  return ((u.input || 0) * max("input") + (u.output || 0) * max("output") + (u.cacheRead || 0) * max("cacheRead") + (u.cacheWrite || 0) * max("cacheWrite")) / 1e6;
}
export class SpendCapError extends Error {
  constructor(public which: "daily" | "monthly", public spent: number, public cap: number) {
    super(`Paused: the ${which} spend cap ($${cap.toFixed(2)}) is reached ($${spent.toFixed(2)} spent). Raise it in Settings → Spend, or wait.`);
    this.name = "SpendCapError";
  }
}
export function overCap(spend: Spend, caps: { daily: number; monthly: number }): SpendCapError | null {
  if (caps.monthly > 0 && spend.month >= caps.monthly) return new SpendCapError("monthly", spend.month, caps.monthly);
  if (caps.daily > 0 && spend.today >= caps.daily) return new SpendCapError("daily", spend.today, caps.daily);
  return null;
}
export async function currentSpend(now = new Date()): Promise<Spend> {
  const { usage } = await readLocal("usage");
  return spendFor(usage, now);
}
// Throws SpendCapError when a cap is reached. Caps of 0 mean no cap.
export async function assertUnderCap(caps: { daily: number; monthly: number }): Promise<void> {
  const err = overCap(await currentSpend(), caps);
  if (err) throw err;
}
