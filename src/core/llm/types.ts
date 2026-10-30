// The provider-neutral shapes of a model call: messages, tools, results, usage.
import type { Settings } from "./settings.js";

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
export type StreamResult = Omit<ModelResult, "model" | "provider" | "ms">;
export interface StreamArgs extends Required<Pick<ModelCallOptions, "system" | "messages" | "tools" | "serverTools">> {
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
export type WatchedResponse = Response & { _activity?: () => void };
