// The checklist for multi-task runs.
import type { PlanItem } from "../types.js";

export const PLAN_MARK: Record<string, string> = { todo: "○", doing: "→", done: "✓", failed: "✗", skipped: "–" };
export const planText = (plan: PlanItem[]) => plan.map((x, i) => `${PLAN_MARK[x.status] || "○"} ${i + 1}. ${x.text}${x.note ? ` (${x.note})` : ""}`).join("\n");
export const planOpen = (plan: PlanItem[] | undefined) => (plan || []).filter(x => x.status === "todo" || x.status === "doing");
