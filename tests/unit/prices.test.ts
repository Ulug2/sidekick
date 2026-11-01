// The price table: dollars per call from token usage (run traces, the benchmark, the spend meter).
import { expect, it } from "vitest";
import { PRICES, costOf, formatCost } from "../../src/core/llm/prices.js";
import { DEFAULT_SETTINGS } from "../../src/core/llm/settings.js";

it("prices every default model except the OpenAI tie-breaker", () => {
  for (const m of [DEFAULT_SETTINGS.anthropicFast, DEFAULT_SETTINGS.anthropicSmart, DEFAULT_SETTINGS.anthropicBest, DEFAULT_SETTINGS.openaiFast, DEFAULT_SETTINGS.openaiSmart]) expect(PRICES[m], m).toBeTruthy();
  // OpenAI usage: input excludes cached tokens, which are billed at 0.1×.
  expect(costOf("gpt-5.6-terra", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 })).toBeCloseTo(2 + 12 + 0.2, 10);
});

it("adds input, output and cache tokens at their own prices", () => {
  // Sonnet 5.5: $2 in, $10 out, $0.20 cache read, $2.50 cache write per million tokens.
  expect(costOf("claude-sonnet-5-5", { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 0 })).toBeCloseTo(2 + 1 + 0.2, 10);
  expect(costOf("claude-opus-5-5", { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 1_000_000 })).toBeCloseTo(20 + 5, 10);
});

it("uses Haiku's higher price once the prompt is over 100K tokens", () => {
  expect(costOf("claude-haiku-5-5", { input: 100_000, output: 1000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo((100_000 * 0.1 + 1000 * 0.5) / 1e6, 12);
  expect(costOf("claude-haiku-5-5", { input: 60_000, output: 1000, cacheRead: 50_000, cacheWrite: 0 })).toBeCloseTo((60_000 * 0.5 + 1000 * 2.5 + 50_000 * 0.05) / 1e6, 12);
});

it("never guesses: models without a price cost null, shown as unknown", () => {
  expect(costOf(DEFAULT_SETTINGS.openaiBest, { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  expect(formatCost(null)).toBe("unknown");
  expect(formatCost(0.0041)).toBe("$0.0041");
  expect(formatCost(1.234)).toBe("$1.23");
});
