// One chat turn: context, the model with its tools, the tool loop, and the math double-check.
// Used by the side panel and by the eval runner.
import { stripWrappers, untrusted } from "../core/security/guard.js";
import { readProblemText } from "../core/browser/screen.js";
import type { TurnInput, TurnUI, TurnResult, Route, TurnTrace, ChatToolEnv, RoundTrace, ChatToolResult, Review, ToolChip } from "./types.js";
import { routeMessage } from "./routing.js";
import { isMathAsk, JUST_ANSWER, needsCheck, reviewAnswer } from "./review/review.js";
import { realMemoryStore, chatTools, executeChatTool, clip } from "./tools.js";
import { buildSystemPrompt, buildTurnContext } from "./prompt.js";
import { effectiveProvider, getSettings, modelFor } from "../core/llm/settings.js";
import { modelCall } from "../core/llm/call.js";
import type { Citation, ToolResult, Usage, ModelMessage } from "../core/llm/types.js";

// Very long chats: keep the most recent messages word for word. Older ones are covered by the
// pinned notes, so the context window never overflows. Always starts on a user message.
export const HISTORY_MAX_MESSAGES = 40;
export const HISTORY_MAX_CHARS = 120000;
export function capHistory(past: ModelMessage[]): ModelMessage[] {
  let start = Math.max(0, past.length - HISTORY_MAX_MESSAGES);
  const size = (i: number) => past.slice(i).reduce((n, m) => n + ((m as { text?: string }).text || "").length, 0);
  while (start < past.length - 2 && size(start) > HISTORY_MAX_CHARS) start += 2;
  while (start < past.length && past[start].role !== "user") start++;
  if (start === 0) return past;
  return [{ role: "user", text: "[Earlier messages in this chat are omitted; the pinned notes cover what matters from them.]" }, { role: "assistant", text: "Understood." }, ...past.slice(start)];
}

// ---------- one turn ----------

export const MAX_TOOL_ROUNDS = 10;
export const serverSearchBroken: Record<string, boolean> = {}; // built-in web search can be disabled by an org admin or unsupported by a model

// history: earlier messages [{ role: "user"|"assistant", text, images? }]
// user: { text, images?, attachments?, quickAction? }
// ui: { onText(chunk), onToolStart(name, args) -> { done(summary), fail(msg) }, onMemory(evt),
//       runAgent?(task) -> summary, signal, tier?, previousTier?, tabInfo?, hasTab?, memoryStore? }
// Returns { text, citations, trace }.
export async function runTurn(history: { role: "user" | "assistant"; text?: string; images?: string[] }[], user: TurnInput, ui: TurnUI): Promise<TurnResult> {
  const s = await getSettings();
  const provider = effectiveProvider(s);
  let route: Route = ui.tier ? { tier: ui.tier, reason: "chosen by you" } : routeMessage(user.text, { attachments: user.attachments, previousTier: ui.previousTier, quickAction: user.quickAction });
  const images = user.images || [];
  const math = isMathAsk({ route, userText: user.text, images });
  // A problem on screen always gets the smart model at high effort, even if you picked "fast".
  let effort: string | undefined;
  if (math.problemOnScreen) {
    if (route.tier !== "smart") route = { tier: "smart", reason: "math on screen" };
    effort = "high";
  }
  const model = modelFor(s, route.tier);
  const hasTab = ui.hasTab !== false;
  const hasAgent = !!ui.runAgent;
  const memory = ui.memoryStore || realMemoryStore;
  const useServerSearch = s.webSearch && !serverSearchBroken[provider];
  const system = await buildSystemPrompt(s, { model, provider, hasAgent, builtInSearch: useServerSearch, memoryStore: memory });
  const tools = chatTools({ provider, webSearchServer: useServerSearch, hasTab, hasAgent });
  const serverTools = !useServerSearch ? [] : provider === "openai" ? [{ type: "web_search" }] : [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
  const context = await buildTurnContext(user.text, { tabInfo: ui.tabInfo, memoryStore: memory, sessionNotes: ui.sessionNotes || [] });

  // Screenshots are downscaled, so small numbers can blur. When the problem came from the open
  // tab, its text (including frames, e.g. MyOpenMath inside Moodle) goes along with the image.
  let userText = user.text;
  if (math.problemOnScreen && hasTab && ui.screenFromTab && typeof readProblemText === "function") {
    ui.onStatus?.("Reading the problem from the page");
    try {
      const page = await readProblemText(8000);
      if (page?.text) userText += `\n\n${untrusted(page.url || "the open page", `The same page as text (use it to read numbers and wording exactly; use the screenshot for diagrams):\n${page.text}${page.truncated ? "\n[shortened]" : ""}`)}`;
    } catch {}
  }

  // Only the newest images are sent; older ones would be re-sent (and paid for) every turn.
  // If this message has none, the most recent earlier images stay, so follow-ups about them work.
  const keepIdx = images.length ? -1 : history.map(m => (m.images || []).length > 0).lastIndexOf(true);
  const past: ModelMessage[] = history.map((m, i): ModelMessage => {
    const n = (m.images || []).length;
    if (i === keepIdx) return { role: m.role, text: m.text || "", images: m.images };
    return { role: m.role, text: (m.text || "") + (n ? `\n[${n} earlier image${n > 1 ? "s" : ""} not shown]` : "") };
  });
  const transcript: ModelMessage[] = [...capHistory(past), { role: "user", text: `${context}\n\n${userText}`, images }];

  const trace: TurnTrace = { route: { ...route, model, effort: effort || (route.tier === "smart" ? s.smartEffort : s.fastEffort) }, rounds: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, started: Date.now() };
  const citations: Citation[] = [];
  const env: ChatToolEnv = {
    memory,
    onMemory: ui.onMemory,
    runAgent: ui.runAgent,
    signal: ui.signal,
    addCitations: list => { for (const c of list) if (c.url && !citations.some(x => x.url === c.url)) citations.push(c); }
  };

  // "Just give me the answer" on a math problem: nothing is shown until the double-check is
  // done, so you never see one answer get swapped for another.
  const hold = !!(s.verifyAnswers && math.any && JUST_ANSWER.test(user.text));
  if (hold) ui.onHold?.();
  let text = "";
  let pendingBreak = false;
  const onText = (chunk: string) => {
    if (pendingBreak && text.trim()) { text += "\n\n"; if (!hold) ui.onText?.("\n\n"); }
    pendingBreak = false;
    text += chunk;
    if (!hold) ui.onText?.(chunk);
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (round === MAX_TOOL_ROUNDS) transcript.push({ role: "user", text: "(You've used many tools. Stop calling tools now and give your best answer with what you have.)" });
    let r: Awaited<ReturnType<typeof modelCall>>;
    try {
      r = await modelCall({ tier: route.tier, model, effort, system, messages: transcript, tools, serverTools, signal: ui.signal, onText, onThinking: t => ui.onThinking?.(t, "Answer") });
    } catch (err: any) {
      if (serverTools.length && /web.?search/i.test(err.message) && !text) {
        // Built-in search unavailable (turned off by an org admin, or not supported by this model): use Sidekick's own search.
        serverSearchBroken[provider] = true;
        serverTools.length = 0;
        tools.push(chatTools({ provider: "openai", webSearchServer: false, hasTab: false, hasAgent: false }).find(t => t.name === "web_search")!);
        round--;
        continue;
      }
      throw err;
    }
    for (const k of Object.keys(trace.usage) as (keyof Usage)[]) trace.usage[k] += r.usage?.[k] || 0;
    env.addCitations(r.citations || []);
    const roundTrace: RoundTrace = { ms: r.ms, model: r.model, usage: r.usage, stop: r.stop, tools: [] };
    trace.rounds.push(roundTrace);
    for (const st of r.serverTools || []) {
      const h = ui.onToolStart?.(st.name, st.args);
      h?.done(st.args?.query ? `“${st.args.query}”` : "");
      roundTrace.tools.push({ name: st.name, args: st.args, result: "(searched by Claude)", ms: 0 });
    }

    if (r.stop === "pause_turn") {
      transcript.push({ role: "assistant", text: r.text, toolCalls: [], raw: r.raw });
      pendingBreak = true;
      continue;
    }
    if (!r.toolCalls.length || round === MAX_TOOL_ROUNDS) break;

    transcript.push({ role: "assistant", text: r.text, toolCalls: r.toolCalls, raw: r.raw });
    const results: ToolResult[] = [];
    for (const call of r.toolCalls) {
      const h = ui.onToolStart?.(call.name, call.args);
      const t0 = Date.now();
      let res: ChatToolResult;
      try {
        res = await executeChatTool(call, env);
        if (res.isError) h?.fail(res.text); else h?.done(res.summary || "");
      } catch (err: any) {
        if (err.name === "AbortError") throw err;
        res = { text: `Error: ${err.message}`, isError: true };
        h?.fail(err.message);
      }
      results.push({ id: call.id, name: call.name, text: res.text, images: res.images, isError: res.isError });
      roundTrace.tools.push({ name: call.name, args: call.args, result: clip(res.text, 1500), ms: Date.now() - t0, error: !!res.isError });
    }
    transcript.push({ role: "tool", results });
    pendingBreak = true;
  }
  // Independent check for math / homework answers.
  const usedCalc = trace.rounds.some(r => r.tools.some(t => t.name === "calculate"));
  let review: Review | null = null;
  if (s.verifyAnswers && needsCheck({ route, userText: user.text, images, reply: text, usedCalc })) {
    const h = ui.onToolStart?.("verify", {});
    let tbChip: ToolChip | null | undefined = null;
    try {
      const r = await reviewAnswer({
        text,
        question: userText.replace(/^<context>[\s\S]*?<\/context>\n\n/, ""),
        images,
        context: past,
        notes: ui.sessionNotes || [],
        signal: ui.signal,
        onThinking: ui.onThinking,
        onTieBreak: () => { tbChip = ui.onToolStart?.("tiebreak", {}); }
      });
      trace.verification = r.verification;
      text = r.text;
      review = r.review || null;
      if (tbChip) (tbChip as ToolChip).done(r.verification.outcome === "conflict" ? "Still disagrees" : r.verification.outcome === "kept-by-vote" ? "Agrees with the original" : "Agrees with the double-check");
      h?.done(r.chip.fixed || r.chip.warn || r.chip.ok);
    } catch (err: any) {
      if (err.name === "AbortError") throw err;
      (tbChip as ToolChip | null | undefined)?.fail(err.message);
      h?.fail(err.message);
    }
  }
  trace.ms = Date.now() - trace.started;
  return { text: stripWrappers(text).trim(), citations, trace, corrected: !!trace.verification?.corrected, review, held: hold };
}
