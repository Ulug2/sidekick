// Shapes the chat brain passes around: the turn's contract with the panel, traces, memory, and the
// math review's setups and verdicts.
import type { Tier, Usage, Citation } from "../core/llm/ai.js";
import type { Memory, SearchHit } from "./memory/memory.js";
import type { Skill } from "./skills.js";

// ---------- types ----------
export interface Route { tier: Tier; reason: string }
// Long-term memory as the chat sees it (the eval runner passes a temporary one).
export interface ChatMemoryStore {
  add(text: string, extra?: Record<string, any>): Promise<{ memory: Memory; updated: boolean }>;
  remove(shortId: string): Promise<Memory | null>;
  search(q: string, scopes?: string[]): Promise<SearchHit[]>;
  relevant(q: string): Promise<Memory[]>;
  standing(): Promise<Memory[]>;
  upcoming(): Promise<Memory[]>;
  skills?: () => Promise<Skill[]>;
  about(): Promise<string>;
}
export interface ToolChip { done(summary?: string): void; fail(msg: string): void }
// How runTurn talks to the panel (or the eval runner).
export interface TurnUI {
  signal?: AbortSignal;
  tier?: Tier;
  previousTier?: Tier | null;
  tabInfo?: { title?: string; url?: string } | null;
  hasTab?: boolean;
  screenFromTab?: boolean;
  sessionNotes?: string[];
  memoryStore?: ChatMemoryStore;
  runAgent?(task: string): Promise<string | null>;
  onText?(chunk: string): void;
  onThinking?(text: string, label?: string): void;
  onStatus?(text: string): void;
  onHold?(): void;
  onToolStart?(name: string, args: any): ToolChip | undefined;
  onMemory?(event: { type: "saved" | "forgot"; memory: Memory; updated?: boolean }): void;
}
export interface TurnInput { text: string; images?: string[]; attachments?: { kind: string }[]; quickAction?: string }
export interface ToolTrace { name: string; args: any; result: string; ms?: number; error?: boolean }
export interface RoundTrace { ms: number; model: string; usage: Usage; stop: string | null; tools: ToolTrace[] }
// A setup block, parsed (see SETUP_FORMAT).
export type Values = Record<string, number>;
export interface Setup { raw: string; variables: string; constraints: string[]; answerText: string; type: "min" | "max" | "equations" | "other"; objective?: string; equations?: string[]; values: Values | null }
export interface Check { ok: boolean | null; evidence: string }
export interface Arbitration { decision: "keep" | "replace" | "undecided"; evidence: string }
export interface Verification {
  verdict: string; reason: string; tools: ToolTrace[]; model: string;
  outcome?: string; corrected?: boolean; evidence?: string;
  selfCheck?: Check; checkerSelfCheck?: Check; arbitration?: Arbitration;
  tieBreak?: { model: string; answer: string; tools: ToolTrace[] } | null;
  vote?: { original: boolean | null; doubleCheck: boolean | null; third: boolean | null };
}
export interface Review { kind: "corrected" | "conflict"; original?: string; reason: string; evidence?: string; by?: string; alternatives?: { label: string; text: string }[] }
export interface ReviewResult { text: string; review?: Review; verification: Verification; chip: { ok?: string; fixed?: string; warn?: string } }
export interface TurnTrace { route: Route & { model: string; effort: string }; rounds: RoundTrace[]; usage: Usage; started: number; ms?: number; verification?: Verification }
export interface TurnResult { text: string; citations: Citation[]; trace: TurnTrace; corrected: boolean; review: Review | null; held: boolean }
export interface ChatToolEnv { memory: ChatMemoryStore; onMemory?: TurnUI["onMemory"]; runAgent?: (task: string) => Promise<string | null>; signal?: AbortSignal; addCitations(list: Citation[]): void }
export interface ChatToolResult { text: string; summary?: string; images?: string[]; isError?: boolean }
// An answer to compare: its final values (if any) and its text without the setup block.
export interface Answer { values?: Values | null; text: string }
