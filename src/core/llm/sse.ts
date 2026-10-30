// Streaming helpers shared by both providers.
import type { WatchedResponse } from "./types.js";

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
