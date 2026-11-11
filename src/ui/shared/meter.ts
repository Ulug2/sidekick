// A spend meter: dollars spent of a cap as a thin bar (Settings → Spend, the Jobs page).
import { formatCost } from "../../core/llm/prices.js";

export function meterEl(label: string, spent: number, cap: number): HTMLElement {
  const share = cap > 0 ? spent / cap : 0;
  const box = document.createElement("div");
  box.className = `meter${cap > 0 && share >= 1 ? " over" : cap > 0 && share >= 0.8 ? " near" : ""}`;
  const top = document.createElement("div");
  top.className = "meter-top";
  const name = document.createElement("span"), value = document.createElement("span");
  name.textContent = label;
  value.textContent = cap > 0 ? `${formatCost(spent)} of $${cap.toFixed(2)}` : `${formatCost(spent)} · no cap`;
  top.append(name, value);
  const bar = document.createElement("div");
  bar.className = "meter-bar";
  bar.setAttribute("role", "meter");
  bar.setAttribute("aria-label", `${label}: ${value.textContent}`);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", String(cap > 0 ? cap : 0));
  bar.setAttribute("aria-valuenow", String(Math.round(spent * 100) / 100));
  const fill = document.createElement("i");
  fill.style.width = `${Math.min(100, Math.round(share * 100))}%`;
  bar.append(fill);
  box.append(top, bar);
  return box;
}
