// Model layer: settings, and one streaming call for Claude and OpenAI with tool use.
// Everything else (persona, routing, tools) lives in brain.js.

export const DEFAULT_SETTINGS = {
  provider: "anthropic",
  anthropicKey: "",
  openaiKey: "",
  // Two tiers: "fast" for everyday questions, "smart" for math, code, analysis and agent work.
  anthropicFast: "claude-haiku-5-5",
  anthropicSmart: "claude-sonnet-5-5",
  openaiFast: "gpt-5.6-luna",
  openaiSmart: "gpt-5.6-terra",
  // Strongest model: only used to break a tie when two solves of a math problem disagree.
  anthropicBest: "claude-opus-5-5",
  openaiBest: "gpt-6-astra",
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
  blockedSites: "paypal.com\nvenmo.com\nchase.com\nbankofamerica.com\nwellsfargo.com\ncapitalone.com\ncoinbase.com\nrobinhood.com\naccounts.google.com\nappleid.apple.com"
};

// ---------- types ----------
export type Settings = typeof DEFAULT_SETTINGS;
export type Tier = "fast" | "smart" | "best";
export type Provider = "anthropic" | "openai";
// args: the JSON the model wrote for the tool, so its shape is only known per tool.
export interface ToolCall { id: string; name: string; args: any }
export interface ToolDef { name: string; description: string; parameters: object }
export interface ToolResult { id: string; name?: string; text: string; images?: string[]; isError?: boolean; snapshot?: string; trimmed?: boolean }
// The provider-neutral transcript (see modelCall). raw = the provider's own blocks, replayed as is.
export type ModelMessage =
  | { role: "user"; text: string; images?: string[]; trimmed?: boolean }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[]; raw?: any[] }
  | { role: "tool"; results: ToolResult[] };
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface Citation { url: string; title: string }
export interface ModelResult {
  text: string;
  toolCalls: ToolCall[];
  serverTools: { name: string; args: any }[];
  raw: any[];
  stop: string | null;
  usage: Usage;
  citations: Citation[];
  model: string;
  provider: Provider;
  ms: number;
}
export interface ModelCallOptions {
  tier?: Tier;
  model?: string;
  effort?: string;
  system: string;
  messages: ModelMessage[];
  tools?: ToolDef[];
  serverTools?: object[]; // provider-native tools (Claude's web search)
  maxTokens?: number;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  parallelTools?: boolean;
}
type StreamResult = Omit<ModelResult, "model" | "provider" | "ms">;
interface StreamArgs extends Required<Pick<ModelCallOptions, "system" | "messages" | "tools" | "serverTools">> {
  s: Settings;
  model: string;
  effort: string;
  maxTokens: number;
  signal: AbortSignal;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  parallelTools?: boolean;
  activity: () => void;
}
// readSSE reports activity to the stall watchdog through the response object.
type WatchedResponse = Response & { _activity?: () => void };

// Settings from earlier versions are carried over once.
export async function migrateSettings(raw: Record<string, any>): Promise<Partial<Settings>> {
  const patch: Partial<Settings> = {};
  if (raw.anthropicModel && !raw.anthropicSmart && !/haiku/.test(raw.anthropicModel)) patch.anthropicSmart = raw.anthropicModel;
  if (raw.openaiModel && !raw.openaiSmart && raw.openaiModel !== "gpt-4o-mini" && raw.openaiModel !== "gpt-5.6-luna") patch.openaiSmart = raw.openaiModel;
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
export function effectiveProvider(s: Settings): Provider {
  if (s.provider === "anthropic" && !s.anthropicKey && s.openaiKey) return "openai";
  if (s.provider === "openai" && !s.openaiKey && s.anthropicKey) return "anthropic";
  return s.provider as Provider;
}

export function modelFor(s: Settings, tier: Tier): string {
  const p = effectiveProvider(s);
  if (tier === "best") return p === "openai" ? s.openaiBest : s.anthropicBest;
  return p === "openai" ? (tier === "smart" ? s.openaiSmart : s.openaiFast) : tier === "smart" ? s.anthropicSmart : s.anthropicFast;
}


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
  return out;
}
export const STALL_MS = 90000;

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

// ---------- streaming helpers ----------

export async function readSSE(res: WatchedResponse, onData: (data: any) => void, activity = res._activity): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    activity?.();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      onData(data);
    }
  }
}

export async function errorFrom(res: Response, name: string): Promise<Error> {
  let msg = `${name} error ${res.status}`;
  try {
    const data = await res.json();
    msg = data?.error?.message || msg;
  } catch {}
  if (res.status === 401) msg += " Check your API key in Settings.";
  if (res.status === 404 && /model/i.test(msg)) msg += " Pick a different model in Settings.";
  if (res.status === 429) msg += " You're being rate-limited; wait a moment and try again.";
  return new Error(msg);
}

export const parseDataUrl = (url: string) => {
  const m = String(url).match(/^data:([^;]+);base64,(.*)$/s);
  return m ? { mediaType: m[1], data: m[2] } : null;
};

// ---------- Claude ----------

export function toAnthropicMessages(messages: ModelMessage[]): { role: string; content: any[] }[] {
  const img = (u: string) => { const d = parseDataUrl(u); return d && { type: "image", source: { type: "base64", media_type: d.mediaType, data: d.data } }; };
  const out: { role: string; content: any[] }[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: [...(m.images || []).map(img).filter(Boolean), { type: "text", text: m.text || " " }] });
    } else if (m.role === "assistant") {
      const content = m.raw || [
        ...(m.text ? [{ type: "text", text: m.text }] : []),
        ...(m.toolCalls || []).map(c => ({ type: "tool_use", id: c.id, name: c.name, input: c.args }))
      ];
      out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no reply)" }] });
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: m.results.map(r => ({
          type: "tool_result",
          tool_use_id: r.id,
          ...(r.isError && { is_error: true }),
          content: [{ type: "text", text: r.text || "(empty)" }, ...(r.images || []).map(img).filter(Boolean)]
        }))
      });
    }
  }
  // The API needs alternating roles; merge consecutive user turns (e.g. tool results + a note).
  const merged: typeof out = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role && m.role === "user") last.content.push(...m.content);
    else merged.push(m);
  }
  return merged;
}

export let openaiNoSummary = false;
// Models that rejected the thinking setting (older ones); they're asked without it from then on.
export const noThinkingModels = new Set<string>();

export async function streamAnthropic({ s, model, effort, system, messages, tools, serverTools, maxTokens, signal, onText, onThinking, parallelTools = false, activity }: StreamArgs): Promise<StreamResult> {
  const body: Record<string, any> = {
    model,
    max_tokens: maxTokens,
    stream: true,
    // Automatic prompt caching: repeated system prompt, tools and history are billed at a fraction.
    cache_control: { type: "ephemeral" },
    system,
    messages: toAnthropicMessages(messages),
    ...(effort && effort !== "auto" && { output_config: { effort } }),
    // Claude 5.x hides its thinking by default; "summarized" streams a readable summary so you
    // can watch what it's doing. Same price either way.
    ...(!noThinkingModels.has(model) && { thinking: { type: "adaptive", display: "summarized" } })
  };
  const allTools = [
    ...tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    ...serverTools
  ];
  if (allTools.length) {
    body.tools = allTools;
    body.tool_choice = { type: "auto", disable_parallel_tool_use: !parallelTools };
  }
  const post = () => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": s.anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(body)
  });
  let res: WatchedResponse = await post();
  if (res.status === 400 && body.thinking) {
    const err = await errorFrom(res, "Anthropic");
    if (!/thinking|adaptive|display/i.test(err.message)) throw err;
    noThinkingModels.add(model);
    delete body.thinking;
    res = await post();
  }
  if (!res.ok) throw await errorFrom(res, "Anthropic");

  const blocks: any[] = [];
  const json: Record<number, string> = {};
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stop: string | null = null;
  let streamError: Error | null = null;
  res._activity = activity;
  await readSSE(res, ev => {
    switch (ev.type) {
      case "message_start": {
        const u = ev.message?.usage || {};
        usage.input = u.input_tokens || 0;
        usage.cacheRead = u.cache_read_input_tokens || 0;
        usage.cacheWrite = u.cache_creation_input_tokens || 0;
        usage.output = u.output_tokens || 0;
        break;
      }
      case "content_block_start": {
        const b = structuredClone(ev.content_block);
        if (b.type === "text") b.text = b.text || "";
        if (b.type === "thinking") b.thinking = b.thinking || "";
        if (b.type === "tool_use" || b.type === "server_tool_use") json[ev.index] = "";
        blocks[ev.index] = b;
        break;
      }
      case "content_block_delta": {
        const b = blocks[ev.index];
        const d = ev.delta;
        if (!b) break;
        if (d.type === "text_delta") { b.text += d.text; onText?.(d.text); }
        else if (d.type === "thinking_delta") { b.thinking = (b.thinking || "") + d.thinking; if (d.thinking) onThinking?.(d.thinking); }
        else if (d.type === "signature_delta") b.signature = d.signature;
        else if (d.type === "input_json_delta") json[ev.index] += d.partial_json;
        else if (d.type === "citations_delta") (b.citations ||= []).push(d.citation);
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index];
        if (b && ev.index in json) {
          try { b.input = json[ev.index] ? JSON.parse(json[ev.index]) : {}; } catch { b.input = {}; }
        }
        break;
      }
      case "message_delta":
        stop = ev.delta?.stop_reason || stop;
        if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens;
        break;
      case "error":
        streamError = new Error(ev.error?.message || "Anthropic stream error");
        break;
    }
  });
  if (streamError) throw streamError;
  const raw = blocks.filter(Boolean);
  const citations: Citation[] = [];
  for (const b of raw) for (const c of b.citations || []) if (c.url && !citations.some(x => x.url === c.url)) citations.push({ url: c.url, title: c.title || c.url });
  return {
    text: raw.filter(b => b.type === "text").map(b => b.text).join(""),
    toolCalls: raw.filter(b => b.type === "tool_use").map(b => ({ id: b.id, name: b.name, args: b.input || {} })),
    serverTools: raw.filter(b => b.type === "server_tool_use").map(b => ({ name: b.name, args: b.input || {} })),
    raw,
    stop,
    usage,
    citations
  };
}

// ---------- OpenAI (Responses API) ----------
// The Responses API is the one that allows function tools together with reasoning on
// gpt-5.x models (Chat Completions rejects that combination), and has built-in web search.
// Requests are stateless (store: false); reasoning is passed back encrypted between rounds.

export function toResponsesInput(messages: ModelMessage[]): any[] {
  const input: any[] = [];
  const userContent = (text: string, images: string[] = []) => [{ type: "input_text", text: text || " " }, ...images.map(url => ({ type: "input_image", image_url: url }))];
  for (const m of messages) {
    if (m.role === "user") {
      input.push({ role: "user", content: userContent(m.text, m.images) });
    } else if (m.role === "assistant") {
      if (m.raw) input.push(...m.raw); // reasoning, function_call and message items exactly as returned
      else {
        if (m.text) input.push({ role: "assistant", content: m.text });
        for (const c of m.toolCalls || []) input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args || {}) });
      }
    } else if (m.role === "tool") {
      const imgs: string[] = [];
      for (const r of m.results) {
        input.push({ type: "function_call_output", call_id: r.id, output: r.text || "(empty)" });
        imgs.push(...(r.images || []));
      }
      if (imgs.length) input.push({ role: "user", content: userContent("Image(s) from the last tool call:", imgs) });
    }
  }
  return input;
}

export async function streamOpenAI({ s, model, effort, system, messages, tools, serverTools = [], maxTokens, signal, onText, onThinking, parallelTools = false, activity }: StreamArgs): Promise<StreamResult> {
  const build = ({ withReasoning = true, withServerTools = true, withSummary = !openaiNoSummary } = {}) => ({
    model,
    instructions: system,
    input: toResponsesInput(messages),
    stream: true,
    store: false,
    max_output_tokens: maxTokens,
    ...(withReasoning && { include: ["reasoning.encrypted_content"] }),
    // summary: "auto" streams a readable summary of the model's reasoning.
    ...(withReasoning && effort && effort !== "auto" && { reasoning: { effort, ...(withSummary && { summary: "auto" }) } }),
    ...((tools.length || (withServerTools && serverTools.length)) && {
      tools: [
        ...tools.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })),
        ...(withServerTools ? serverTools : [])
      ],
      parallel_tool_calls: !!parallelTools
    })
  });
  const post = (body: object) => fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${s.openaiKey}` },
    body: JSON.stringify(body)
  });

  let res: WatchedResponse = await post(build());
  if (res.status === 400) {
    // Older, non-reasoning models (e.g. gpt-4o-mini) reject reasoning settings: retry without them.
    const err = await errorFrom(res, "OpenAI");
    // Reasoning summaries need a verified organization on some accounts: keep reasoning, drop the summary.
    if (/summar/i.test(err.message)) { openaiNoSummary = true; res = await post(build({ withSummary: false })); }
    else if (/reasoning|encrypted_content|include/i.test(err.message)) res = await post(build({ withReasoning: false }));
    else throw err;
  }
  if (!res.ok) throw await errorFrom(res, "OpenAI");

  let text = "";
  const items: any[] = [];
  const citations: Citation[] = [];
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let status = "completed";
  let streamError: Error | null = null;
  res._activity = activity;
  await readSSE(res, ev => {
    switch (ev.type) {
      case "response.output_text.delta":
        text += ev.delta;
        onText?.(ev.delta);
        break;
      case "response.reasoning_summary_text.delta":
        if (ev.delta) onThinking?.(ev.delta);
        break;
      case "response.reasoning_summary_part.added":
        onThinking?.("\n\n");
        break;
      case "response.output_text.annotation.added": {
        const a = ev.annotation;
        if (a?.type === "url_citation" && a.url && !citations.some(c => c.url === a.url)) citations.push({ url: a.url, title: a.title || a.url });
        break;
      }
      case "response.output_item.done":
        items[ev.output_index] = ev.item;
        break;
      case "response.completed":
      case "response.incomplete": {
        const r = ev.response || {};
        status = r.status || status;
        if (Array.isArray(r.output) && r.output.length) r.output.forEach((it: any, i: number) => (items[i] = it));
        const u = r.usage || {};
        usage.cacheRead = u.input_tokens_details?.cached_tokens || 0;
        usage.input = (u.input_tokens || 0) - usage.cacheRead;
        usage.output = u.output_tokens || 0;
        break;
      }
      case "response.failed":
        streamError = new Error(ev.response?.error?.message || "OpenAI request failed");
        break;
      case "error":
        streamError = new Error(ev.message || ev.error?.message || "OpenAI stream error");
        break;
    }
  });
  if (streamError) throw streamError;

  const raw = items.filter(Boolean);
  const toolCalls = raw.filter(i => i.type === "function_call").map(i => {
    let args = {};
    try { args = i.arguments ? JSON.parse(i.arguments) : {}; } catch {}
    return { id: i.call_id, name: i.name, args };
  });
  for (const m of raw.filter(i => i.type === "message")) {
    for (const part of m.content || []) {
      for (const a of part.annotations || []) {
        if (a.type === "url_citation" && a.url && !citations.some(c => c.url === a.url)) citations.push({ url: a.url, title: a.title || a.url });
      }
    }
  }
  // If deltas didn't arrive (some proxies buffer), fall back to the final message text.
  if (!text) {
    text = raw.filter(i => i.type === "message").flatMap(m => (m.content || []).filter((p: any) => p.type === "output_text").map((p: any) => p.text)).join("");
    if (text) onText?.(text);
  }
  return {
    text,
    toolCalls,
    serverTools: raw.filter(i => i.type === "web_search_call").map(i => ({ name: "web_search", args: { query: i.action?.query || i.action?.queries?.[0] || "" } })),
    raw,
    stop: toolCalls.length ? "tool_use" : status === "incomplete" ? "max_tokens" : "end_turn",
    usage,
    citations
  };
}

// ---------- usage tracking ----------

// Tokens per day (YYYY-MM-DD) per model; the last 90 days are kept.
export type UsageLog = Record<string, Record<string, Usage & { calls: number }>>;
export let usageQueue: Promise<void> = Promise.resolve();
export function recordUsage(model: string, u: Usage | undefined): Promise<void> {
  if (!u) return Promise.resolve();
  usageQueue = usageQueue.then(async () => {
    const { usage = {} } = (await chrome.storage.local.get("usage")) as { usage?: UsageLog };
    const day = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
    const d = (usage[day] ||= {});
    const m = (d[model] ||= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    m.calls++;
    m.input += u.input || 0;
    m.output += u.output || 0;
    m.cacheRead += u.cacheRead || 0;
    m.cacheWrite += u.cacheWrite || 0;
    const days = Object.keys(usage).sort();
    for (const old of days.slice(0, Math.max(0, days.length - 90))) delete usage[old];
    await chrome.storage.local.set({ usage });
  });
  return usageQueue;
}
