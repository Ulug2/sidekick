// Step titles shown to you, and value-free versions for learning.
import type { ToolCall } from "../../core/llm/ai.js";
import type { Elements, AgentState } from "../types.js";
import { hostOf } from "../page-calls.js";
import { questionOfLine } from "../skills/adapters.js";

export const quote = (s: unknown) => `“${String(s || "").slice(0, 60)}”`;

// A step without any values typed or chosen (for learning site notes).
export function describeSafe(call: ToolCall, el: Elements[string] | undefined): string {
  const a = call.args || {};
  const target = el ? quote(el.label || el.role) : "";
  switch (call.name) {
    case "type": return `Type into ${target}`;
    case "select_option": return `Choose an option in ${target}`;
    case "pick_date": return `Pick a date in ${target}`;
    case "set_checked": return `${a.checked ? "Check" : "Uncheck"} ${target}`;
    case "click": return `Click ${target}`;
    case "click_at": return "Click at a point on a screenshot";
    case "fill_fields": return `Fill ${Array.isArray(a.fields) ? a.fields.length : 0} fields at once`;
    case "navigate": case "open_tab": return `Go to ${hostOf(a.url) || "a page"}`;
    case "ask_user": return "Ask the user a question";
    case "site_tool": return `Use the site's “${a.name}” tool`;
    case "log_application": return "Log the application";
    case "done": return "Finish";
    default: return call.name.replace(/_/g, " ") + (target ? ` ${target}` : "");
  }
}

export function describeCall(call: ToolCall, state: AgentState): string {
  const a = call.args || {};
  const el = state.elements[String(a.id)];
  const target = el ? quote(el.label || el.role) : a.id ? `[${a.id}]` : "";
  switch (call.name) {
    case "click": return a.description ? `${a.description}` : `Click ${target}`;
    case "type": return `Type ${quote(a.text)} into ${target}`;
    case "select_option": return `Choose ${quote(a.option)} in ${target}`;
    case "pick_date": { const d = new Date(String(a.date) + "T12:00:00"); return `Pick ${isNaN(d as any) ? a.date : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} in ${target}`; }
    case "set_checked": {
      const q = el && questionOfLine(el.line);
      if (el?.role === "radio") return `Choose ${target}${q ? ` for ${quote(q)}` : ""}`;
      return `${a.checked ? "Check" : "Uncheck"} ${target}${q && el?.role !== "checkbox" ? ` for ${quote(q)}` : ""}`;
    }
    case "upload_file": return `Attach your resume to ${target}`;
    case "press_key": return `Press ${a.key}${target ? " in " + target : ""}`;
    case "scroll": return a.direction === "all" ? "Load the whole page" : `Scroll ${a.direction}`;
    case "read_text": return "Read the page";
    case "find": return `Look for “${String(a.query || "").slice(0, 40)}” on the page`;
    case "web_search": return `Search the web for “${String(a.query || "").slice(0, 50)}”`;
    case "plan": return a.items ? `Plan: ${Array.isArray(a.items) ? a.items.length : 0} tasks` : `Task ${a.update?.item}: ${a.update?.status}`;
    case "screenshot": return "Look at the screen";
    case "click_at": return a.description || `Click at (${Math.round(a.x)}, ${Math.round(a.y)})`;
    case "navigate": return `Go to ${hostOf(a.url) || a.url}`;
    case "go_back": return "Go back";
    case "open_tab": return `Open ${hostOf(a.url) || a.url} in a new tab`;
    case "list_tabs": return "Check open tabs";
    case "switch_tab": return "Switch tabs";
    case "wait": return `Wait ${a.seconds}s`;
    case "ask_user": return "Ask you a question";
    case "log_application": return `Log application: ${a.role} at ${a.company}`;
    case "fill_fields": { const n = Array.isArray(a.fields) ? a.fields.length : 0; return `Fill ${n} field${n === 1 ? "" : "s"}`; }
    case "use_shortcut": return `Use the shortcut “${(state.shortcuts?.[a.shortcut_id]?.title || a.shortcut_id || "").slice(0, 50)}”`;
    case "site_tool": return `Use the site's “${a.name}” tool`;
    case "done": return "Finish";
    default: return call.name;
  }
}
