// Settings (with their defaults and model IDs) and which provider and model a call uses.
import { MODEL_IDS, LEGACY_MODEL_IDS, modelForTier, providerOf } from "./models.js";
import type { Provider, Tier } from "./types.js";

// Everything else (persona, routing, tools) lives in brain.js.

export const DEFAULT_SETTINGS = {
  provider: "anthropic",
  anthropicKey: "",
  openaiKey: "",
  // Two tiers: "fast" for everyday questions, "smart" for math, code, analysis and agent work.
  // The IDs live in models.ts (the only file that may name a model); these are the overrides.
  anthropicFast: MODEL_IDS.anthropic.fast,
  anthropicSmart: MODEL_IDS.anthropic.smart,
  openaiFast: MODEL_IDS.openai.fast,
  openaiSmart: MODEL_IDS.openai.smart,
  // Strongest model: only used to break a tie when two solves of a math problem disagree.
  anthropicBest: MODEL_IDS.anthropic.best,
  openaiBest: MODEL_IDS.openai.best,
  // Spend caps in dollars (core/llm/budget.ts); 0 = no cap.
  capDaily: 1,
  capMonthly: 25,
  routing: "auto", // "auto" | "fast" | "smart"
  fastEffort: "low",
  smartEffort: "high",
  agentEffort: "medium",
  webSearch: true,
  verifyAnswers: true, // independently re-check math and homework answers
  // assistant
  assistantName: "Sidekick",
  addressAs: "", // empty = the user's first name from their profile
  personality: "balanced", // concise | balanced | warm | witty | formal
  proactive: true,
  customInstructions: "",
  // memory
  memoryAuto: true,
  // voice
  readAloud: false,
  // agent permissions
  approvalMode: "final", // "final" = ask before submit/send/buy/delete; "every" = ask before every action
  trustedInput: true, // use Chrome's debugger for real clicks and typing
  learnSites: true, // save shortcuts and notes for sites after a finished agent task
  notifyAgent: true, // a Chrome notification when the agent needs you or finishes and you're elsewhere
  agentTabGroup: true, // tabs the agent opens go into a "Sidekick" tab group
  actionCheck: true, // the fast model double-checks visits to new sites and sharing your details there
  recordRuns: true, // save each agent run step by step (screenshots, model calls, cost) for the Agent runs page
  blockedSites: "paypal.com\nvenmo.com\nchase.com\nbankofamerica.com\nwellsfargo.com\ncapitalone.com\ncoinbase.com\nrobinhood.com\naccounts.google.com\nappleid.apple.com"
};

// ---------- types ----------
export type Settings = typeof DEFAULT_SETTINGS;

// Settings from earlier versions are carried over once.
export async function migrateSettings(raw: Record<string, any>): Promise<Partial<Settings>> {
  const patch: Partial<Settings> = {};
  if (raw.anthropicModel && !raw.anthropicSmart && !/haiku/.test(raw.anthropicModel)) patch.anthropicSmart = raw.anthropicModel;
  if (raw.openaiModel && !raw.openaiSmart && raw.openaiModel !== LEGACY_MODEL_IDS.openaiOld && raw.openaiModel !== MODEL_IDS.openai.fast) patch.openaiSmart = raw.openaiModel;
  if (raw.reasoning && raw.reasoning !== "auto" && !raw.smartEffort) patch.smartEffort = raw.reasoning;
  // A system prompt you wrote yourself becomes custom instructions; built-in ones are dropped.
  const old = String(raw.systemPrompt || "").trim();
  if (old && !raw.customInstructions && !/^You are Sidekick, (a concise|an assistant in a Chrome side panel)/.test(old)) {
    patch.customInstructions = old;
  }
  if (Object.keys(patch).length || "systemPrompt" in raw || "anthropicModel" in raw || "openaiModel" in raw || "reasoning" in raw) {
    await chrome.storage.local.set(patch);
    await chrome.storage.local.remove(["systemPrompt", "anthropicModel", "openaiModel", "reasoning"]);
  }
  return patch;
}

export async function getSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get([...Object.keys(DEFAULT_SETTINGS), "systemPrompt", "anthropicModel", "openaiModel", "reasoning"]);
  const patch = ("systemPrompt" in raw || "anthropicModel" in raw || "openaiModel" in raw || "reasoning" in raw) ? await migrateSettings(raw) : {};
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (raw[k] !== undefined && raw[k] !== "") s[k] = raw[k];
  // Some fields may legitimately be empty strings.
  for (const k of ["customInstructions", "addressAs", "anthropicKey", "openaiKey"]) if (typeof raw[k] === "string") s[k] = raw[k];
  return { ...s, ...patch } as Settings;
}

// The chosen provider, or whichever one actually has a key.
export const effectiveProvider = (s: Settings): Provider => providerOf(s);
export const modelFor = (s: Settings, tier: Tier): string => modelForTier(s, tier);
