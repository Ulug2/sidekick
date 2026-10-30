// Everything Sidekick keeps in chrome.storage, in one place. Storage is chrome.storage.local
// (unencrypted, like every extension), plus one hand-off value in chrome.storage.session.
// readLocal() is chrome.storage.local.get with these types; writes still go through
// chrome.storage.local.set at each owner (see the module named next to each key).
import type { Application, Profile } from "../../assistant/profile-core.js";
import type { DocChunks, DocIndexEntry, Memory } from "../../assistant/memory/memory.js";
import type { Skill } from "../../assistant/skills.js";
import type { UserModel } from "../../assistant/session.js";
import type { Shortcut, SiteNote } from "../../agent/types.js";
import type { Settings } from "../llm/settings.js";
import type { UsageLog } from "../llm/usage.js";

// ---------- chats (ui/sidepanel) ----------
export interface ChatIndexEntry { id: string; title: string; updatedAt: number }
export interface ChatDisplay { prompt?: string; quote?: string; page?: string; files?: string[]; images?: string[]; agent?: boolean }
// A saved message. User messages carry what was shown (display); assistant messages carry
// what's needed to show the reply again (trace, citations, review, thinking, agent runs).
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  images?: string[];
  display?: ChatDisplay;
  canReplace?: boolean;
  quickAction?: string;
  attachmentKinds?: { kind: string }[];
  tier?: string;
  trace?: any; // brain's TurnTrace
  citations?: { url: string; title: string }[];
  review?: any; // brain's math review result
  thoughts?: any;
  agentRuns?: any[];
  agentSteps?: string[];
  agentPlan?: any[];
  stopped?: boolean;
  [extra: string]: unknown;
}
export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  notes?: string[]; // pinned notes for this chat (assistant/session)
  reflected?: boolean;
  [extra: string]: unknown;
}

// ---------- quality checks (ui/evals) ----------
export interface EvalRun { date: number; configKey: string; passed: number; total: number; models: string[]; results: Record<string, { pass: boolean; note?: string }> }

// ---------- the schema ----------
export interface LocalSchema extends Settings {
  profile: Profile; // assistant/profile-core
  applications: Application[]; // assistant/profile-core
  memories: Memory[]; // assistant/memory/memory
  docIndex: DocIndexEntry[]; // assistant/memory/memory; each document's text is under doc:<id>
  skills: Skill[]; // assistant/skills
  userModel: UserModel; // assistant/session
  adapters: Shortcut[]; // agent/skills/adapters (learned site shortcuts)
  siteNotes: Record<string, SiteNote[]>; // agent/skills/adapters, by site
  chatIndex: ChatIndexEntry[]; // ui/sidepanel; each chat is under chat:<id>
  usage: UsageLog; // core/llm
  evalRuns: EvalRun[]; // ui/evals
  [chat: `chat:${string}`]: Chat;
  [doc: `doc:${string}`]: DocChunks;
}
export interface SessionSchema {
  // The context menu's hand-off to the panel (background → sidepanel).
  pending: { mode: "rewrite" | "ask"; text: string; ts: number };
}

export async function readLocal<K extends keyof LocalSchema>(keys: K | K[]): Promise<Partial<Pick<LocalSchema, K>>> {
  return (await chrome.storage.local.get(keys as any)) as Partial<Pick<LocalSchema, K>>;
}
