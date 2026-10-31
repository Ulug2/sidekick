// One model call for Claude and OpenAI: streaming, tool use, a watchdog for silent connections
// (90 s → retry once), and usage tracking. Persona, routing and tools live in src/assistant.
import type { ModelCallOptions, ModelResult, StreamResult, StreamArgs, ModelMessage, Tier, ToolDef } from "./types.js";
import { getSettings, effectiveProvider, modelFor } from "./settings.js";
import { streamOpenAI } from "./openai.js";
import { streamAnthropic } from "./anthropic.js";
import { recordUsage } from "./usage.js";

// ---------------------------------------------------------------------------------------
// One model call.
// messages (neutral format):
//   { role: "user", text, images?: [dataURL] }
//   { role: "assistant", text, toolCalls?: [{ id, name, args }], raw? }   raw = provider blocks
//   { role: "tool", results: [{ id, name, text, images? }] }
// tools: [{ name, description, parameters }] plus, for Claude, optional server tools.
// Returns { text, toolCalls, raw, stop, usage, citations, model, provider, ms }.
// ---------------------------------------------------------------------------------------
export async function modelCall({ tier = "fast", model, effort, system, messages, tools = [], serverTools = [], maxTokens, signal, onText, onThinking, parallelTools = false }: ModelCallOptions): Promise<ModelResult> {
  const s = await getSettings();
  if (!s.anthropicKey && !s.openaiKey) throw new Error("Add an API key in Settings (Anthropic or OpenAI).");
  const provider = effectiveProvider(s);
  model ||= modelFor(s, tier);
  effort ||= tier === "fast" ? s.fastEffort : s.smartEffort;
  maxTokens ||= tier === "fast" ? 8000 : 32000;
  const started = Date.now();
  // A connection that goes silent would otherwise hang forever (the "frozen" agent): if nothing
  // arrives for a while, give up on that request and try once more.
  let result!: StreamResult;
  for (let attempt = 1; ; attempt++) {
    const watch = new AbortController();
    const relay = () => watch.abort(signal!.reason);
    if (signal?.aborted) watch.abort(signal.reason); else signal?.addEventListener("abort", relay, { once: true });
    let stalled = false, wrote = false, timer: ReturnType<typeof setTimeout> | undefined, giveUp!: (err: Error) => void;
    // Rejects when the connection goes quiet, even if the stream itself never notices.
    const quiet = new Promise<never>((_, reject) => (giveUp = reject));
    quiet.catch(() => {});
    const activity = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; watch.abort(); giveUp(new Error("stalled")); }, globalThis.SK_STALL_MS || STALL_MS); };
    const textOut = onText && ((t: string) => { wrote = true; onText(t); });
    activity();
    try {
      const args: StreamArgs = { s, model, effort, system, messages, tools, serverTools, maxTokens, signal: watch.signal, onText: textOut, onThinking, parallelTools, activity };
      const streaming = provider === "openai" ? streamOpenAI(args) : streamAnthropic(args);
      streaming.catch(() => {});
      result = await Promise.race([streaming, quiet]);
      break;
    } catch (err) {
      if (!stalled || signal?.aborted) throw err;
      if (attempt >= 2 || wrote) throw Object.assign(new Error(`The AI service stopped responding (nothing for ${Math.round((globalThis.SK_STALL_MS || STALL_MS) / 1000)}s). Try again in a moment.`), { name: "StreamStalled" });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    }
  }
  const out: ModelResult = Object.assign(result, { model, provider, ms: Date.now() - started });
  recordUsage(model, result.usage).catch(() => {});
  if (signal) try { callWatchers.get(signal)?.(out, system); } catch (err) { console.warn("Call watcher failed", err); }
  return out;
}
export const STALL_MS = 90000;

// Every call made with a given Stop signal is reported to its watcher (an agent run's trace
// records its own calls this way, including the safety checks and notes it triggers).
const callWatchers = new WeakMap<AbortSignal, (r: ModelResult, system: string) => void>();
export function watchModelCalls(signal: AbortSignal, fn: (r: ModelResult, system: string) => void): () => void {
  callWatchers.set(signal, fn);
  return () => { if (callWatchers.get(signal) === fn) callWatchers.delete(signal); };
}

// Kept for the profile page's resume parsing: plain text in, text out.
export async function callModel(messages: ModelMessage[], onText: (text: string) => void = () => {}, signal?: AbortSignal, opts: { tier?: Tier; system?: string } = {}): Promise<string> {
  const r = await modelCall({ tier: opts.tier || "fast", system: opts.system || "You are a helpful assistant.", messages, signal, onText });
  return r.text;
}

// Used by agent mode.
export async function callAgentModel({ system, transcript, tools, signal, onThinking }: { system: string; transcript: ModelMessage[]; tools: ToolDef[]; signal?: AbortSignal; onThinking?: (text: string) => void }): Promise<ModelResult> {
  const s = await getSettings();
  // The agent may batch several sure actions in one turn (e.g. type, then click Next).
  return modelCall({ tier: "smart", effort: s.agentEffort, system, messages: transcript, tools, signal, maxTokens: 16000, parallelTools: true, onThinking });
}
