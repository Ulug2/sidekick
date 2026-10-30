// Claude (Messages API): adaptive thinking with a readable summary, prompt caching, tools.
import type { ModelMessage, StreamArgs, StreamResult, WatchedResponse, Usage, Citation } from "./types.js";
import { parseDataUrl, errorFrom, readSSE } from "./sse.js";

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
