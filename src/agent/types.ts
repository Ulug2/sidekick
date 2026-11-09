// Shapes the browser agent passes around: what the page scripts return (snapshots, action
// results), the elements the model can act on, the agent's tool calls, and what it learns.
// Types only: page scripts (src/page) may import these with `import type`.
import type { TrustedInput } from "../core/browser/cdp.js";
import type { Settings } from "../core/llm/settings.js";

// ---------- page snapshot (page/snapshot.ts → agent) ----------
// A site's form declared as a tool for AI agents (WebMCP declarative API).
export interface FormToolParam { name: string; description: string; required: boolean; type: string; options?: string[] }
export interface FormTool { name: string; description: string; form: string; params: FormToolParam[]; autosubmit: boolean }
// One frame's view. `elements` are text lines the model reads, e.g.
// `[12] button "Apply" (section: Job), offscreen`, and `## Section` headings between them;
// captureTab parses the id, role and label back out of each line.
export interface FrameSnapshot {
  title: string;
  url: string;
  isTop: boolean;
  frames: { host: string; title: string }[]; // embedded frames big enough to matter
  scroll: { y: number; height: number; viewport: number; width: number };
  dialog: string;
  headings: string[];
  errors: string[];
  elements: string[];
  formTools: FormTool[];
  skipped: number;
  traps: number;
  text: string;
  textLength: number;
}
export interface SnapshotOptions { maxElements?: number; maxText?: number }

// ---------- page actions (agent → page/act.ts) ----------
export type PageOp =
  | "read_text" | "scroll" | "describe_point" | "click_point" | "locate" | "prepare_type" | "enter_check"
  | "click" | "type" | "select_option" | "pick_date" | "set_checked" | "upload_file" | "press_key" | "fill_form_tool";
// The tool's own arguments travel along (id, text, option, date, checked, key, direction, …).
export interface PageAction { op: PageOp; id?: string; [arg: string]: any }
export type PageActionResult =
  | {
      ok: true;
      note?: string;
      text?: string; truncated?: boolean; url?: string; frames?: string[]; // read_text (frames: hosts of the visible embedded frames)
      x?: number; y?: number; covered?: string; // locate
      label?: string; tag?: string; isFrame?: boolean; // describe_point, click_point
      math?: boolean; erase?: number; focused?: boolean; // prepare_type
      formFields?: number; inTextarea?: boolean; // enter_check
      filled?: string[]; missing?: string[]; submitted?: boolean; // fill_form_tool
    }
  | { ok: false; error: string };

// ---------- what the agent knows about the page ----------
// An element the model can act on, keyed by its snapshot id ("12", or "3:12" inside frame 3).
export interface ElementInfo { role: string; label: string; line: string; frameId: number; host: string; section: string }
export type Elements = Record<string, ElementInfo>;
// A site tool: registered by the page (WebMCP) or declared by a form.
export interface SiteTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, any>; required?: string[] };
  readOnly?: boolean;
  source?: "form";
  form?: string;
  autosubmit?: boolean;
}

// ---------- learning (agent/skills/adapters.ts) ----------
// One successful action, by meaning (never the value you typed is stored from this).
export interface ActionLogEntry {
  tool: string;
  role: string;
  label: string;
  question: string;
  section: string;
  nth: number;
  host: string;
  site: string;
  value?: string | boolean;
  final: boolean;
  description: string;
}
// A replayable step of a learned shortcut. valueKey/labelKey name a profile field, never a value.
export interface ShortcutStep {
  tool: string;
  role: string;
  label: string;
  question: string;
  section: string;
  nth: number;
  description: string;
  final?: boolean;
  needsModel?: boolean;
  hint?: string;
  valueKey?: string;
  labelKey?: string;
  value?: string | boolean;
  optional?: boolean;
}
export interface Shortcut { id: string; site: string; goal: string; title: string; steps: ShortcutStep[]; created: number; updated: number; runs: number; replays: number; replayOk: number }
export interface SiteNote { text: string; added: number }

// ---------- an agent run ----------
export type PlanStatus = "todo" | "doing" | "done" | "failed" | "skipped";
export interface PlanItem { text: string; status: PlanStatus | string; note?: string }
// One frame of a capture, after its lines got frame-prefixed ids ("3:12").
export interface CapturedFrame {
  frameId: number; url: string; isTop: boolean; dialog: string; headings: string[]; errors: string[]; lines: string[];
  skipped: number; traps: number; text: string; textLength: number; formTools: (FormTool & { frameId: number })[];
}
export interface Capture {
  title: string; url: string; frames: CapturedFrame[]; siteTools: SiteTool[];
  protected?: boolean; error?: string; blockedFrames?: { count: number; hosts: string[] }; scroll?: FrameSnapshot["scroll"];
}
// The last full snapshot, so later ones can list only what changed.
export interface SnapshotBase { page: string; lines: Map<string, string>; at: number; headings: string; textHead: string; toolsKey: string; blockedKey: string }
export interface AgentState {
  tabId: number;
  goal: string;
  settings: Settings;
  elements: Elements;
  siteTools: Record<string, SiteTool>;
  shortcuts: Record<string, Shortcut>;
  steps: string[]; // step titles shown to you
  safeSteps: string[]; // the same steps without any values (for site notes)
  actionLog: ActionLogEntry[]; // successful actions, by meaning (for shortcuts)
  errors: string[];
  answers: string[];
  input: TrustedInput | null;
  signal?: AbortSignal;
  userContext?: string[];
  startSite?: string;
  visitOk: Set<string>;
  shareOk: Set<string>;
  uploadOk?: Set<string>;
  plan?: PlanItem[];
  planApproval?: { sites: Set<string>; autoSubmit: boolean };
  deferSnapshot?: boolean;
  viewport?: { width: number; height: number };
  groupId?: number | null;
  lastActionAt?: number;
  snapCount?: number;
  lastSnapHost?: string;
  lastSnapshotKind?: string;
  base?: SnapshotBase | null;
  finished?: boolean;
  inputTimedOut?: boolean;
  inputFailedFor?: number;
  // Answers read from images: when it last looked (screenshot, zoom), when it typed after
  // looking, and whether done already sent it back once to check them.
  lookedAt?: number;
  typedAfterLook?: number;
  checkAsked?: boolean;
}
// A step card in the panel.
export interface StepHandle { done(ok: boolean, detail?: string): void; waiting(): void }
// How the agent talks to the panel (sidepanel.runAgentCard) or a test.
export interface AgentUI {
  signal: AbortSignal;
  step(text: string, tool?: string): StepHandle;
  note(text: string): void;
  thinking?(chunk: string): void;
  plan?(items: PlanItem[]): void;
  approve(req: { title: string; detail: string }): Promise<boolean>;
  approvePlan?(req: { items: string[]; sites: string[] }): Promise<{ ok: boolean; autoSubmit?: boolean } | undefined>;
  ask(question: string): Promise<string>;
  traceStarted?(id: string): void; // the run is being recorded under this id (Agent runs page)
}
// What a tool call returns to the loop (text goes back to the model).
export interface ToolOutcome { text: string; images?: string[]; failed?: boolean; declined?: boolean; errorMsg?: string; snapshot?: string; done?: boolean; summary?: string }
export interface AgentRunResult { summary: string | null; steps: string[]; learned: { shortcut?: { id: string; title: string; site: string; steps: number; automatic: number }; notes?: string[] } | null; plan?: PlanItem[]; traceId?: string }
export type AskApproval = (title: string, detail: string) => Promise<boolean>;
