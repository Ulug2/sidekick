// OpenAI (Responses API): stateless (store: false), reasoning replayed encrypted between rounds.
import type { ModelMessage, StreamArgs, StreamResult, WatchedResponse, Citation, Usage } from "./types.js";
import { errorFrom, readSSE } from "./sse.js";

export let openaiNoSummary = false;

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
