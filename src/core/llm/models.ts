// Every model ID, in one place (the only file in src/ besides prices.ts that may contain one; a
// lint rule enforces it). Roles say which model does what and with how much thinking; tiers are the
// older fast/smart/best names the chat still uses, mapped onto the same catalog.
import type { Settings } from "./settings.js";
import type { Provider, Tier } from "./types.js";
export const MODEL_IDS = {
  anthropic: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5", best: "claude-opus-5-5", deep: "claude-fable-5-1" },
  openai: { fast: "gpt-5.6-luna", smart: "gpt-5.6-terra", best: "gpt-6-astra", deep: "gpt-6-astra" }
} as const;
// Model names from older settings that are migrated or dropped (settings.ts migrateSettings).
export const LEGACY_MODEL_IDS = { openaiOld: "gpt-4o-mini" } as const;

// What each part of Sidekick runs on ($25/month plan, docs/COSTS.md). "deep" is the strongest
// model and is only used when Ulugbek asks for it in chat.
export type Role = "brain" | "brainDeep" | "browser" | "browserRetry" | "writer" | "classifier" | "tieBreak";
export interface RoleConfig { tier: Tier | "deep"; effort: "low" | "medium" | "high"; maxTokens: number; what: string }
export const ROLES: Record<Role, RoleConfig> = {
  brain: { tier: "smart", effort: "medium", maxTokens: 8000, what: "ranks the daily batch, reviews failed runs, triages Needs You" },
  brainDeep: { tier: "deep", effort: "high", maxTokens: 16000, what: "hard questions Ulugbek asks for explicitly" },
  browser: { tier: "fast", effort: "low", maxTokens: 16000, what: "applies to jobs and reads course sites" },
  browserRetry: { tier: "smart", effort: "medium", maxTokens: 16000, what: "a second try when the fast browser worker failed" },
  writer: { tier: "smart", effort: "low", maxTokens: 1500, what: "cover letters, open-ended answers, email drafts" },
  classifier: { tier: "fast", effort: "low", maxTokens: 800, what: "email triage, date extraction, question matching, eligibility edge cases" },
  tieBreak: { tier: "best", effort: "high", maxTokens: 32000, what: "breaks a tie between two math solves" }
};

export function providerOf(s: Settings): Provider {
  if (s.provider === "anthropic" && !s.anthropicKey && s.openaiKey) return "openai";
  if (s.provider === "openai" && !s.openaiKey && s.anthropicKey) return "anthropic";
  return s.provider as Provider;
}
// The model for a tier, with the Settings page's overrides (anthropicFast, openaiSmart, …).
export function modelForTier(s: Settings, tier: Tier | "deep"): string {
  const p = providerOf(s);
  if (tier === "deep") return MODEL_IDS[p].deep;
  if (tier === "best") return p === "openai" ? s.openaiBest : s.anthropicBest;
  return p === "openai" ? (tier === "smart" ? s.openaiSmart : s.openaiFast) : tier === "smart" ? s.anthropicSmart : s.anthropicFast;
}
export function modelForRole(s: Settings, role: Role): { model: string; effort: RoleConfig["effort"]; maxTokens: number; tier: RoleConfig["tier"] } {
  const r = ROLES[role];
  return { model: modelForTier(s, r.tier), effort: r.effort, maxTokens: r.maxTokens, tier: r.tier };
}
