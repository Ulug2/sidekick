// Injected into web pages with chrome.scripting.executeScript({ func }), which sends the
// function's source text: it must not use anything outside its own body (no imports, no helpers).

// ---------- WebMCP: tools a website offers to AI agents ----------
// These run in the page's own JavaScript world (world: "MAIN"), where the site registered its
// tools with navigator.modelContext. webmcp-capture.js records them as they're registered.

export async function skWebMCPList() {
  const out = [];
  const seen = new Set();
  const add = (t, source) => {
    if (!t || !t.name || seen.has(t.name)) return;
    seen.add(t.name);
    let schema = t.inputSchema || t.parameters || { type: "object", properties: {} };
    if (typeof schema === "string") { try { schema = JSON.parse(schema); } catch { schema = { type: "object", properties: {} }; } }
    out.push({
      name: String(t.name).slice(0, 64),
      description: String(t.description || "").replace(/\s+/g, " ").slice(0, 300),
      inputSchema: JSON.parse(JSON.stringify(schema || {})),
      readOnly: !!(t.annotations && t.annotations.readOnlyHint),
      source
    });
  };
  try { const reg = window.__skWebMCP; if (reg && reg.tools) for (const t of reg.tools.values()) add(t, "page"); } catch {}
  try {
    const testing = navigator.modelContextTesting;
    if (testing && typeof testing.listTools === "function") for (const t of (await testing.listTools()) || []) add(t, "chrome");
  } catch {}
  return out.slice(0, 30);
}

export async function skWebMCPCall(req) {
  const name = req && req.name;
  const args = (req && req.args) || {};
  try {
    const t = window.__skWebMCP && window.__skWebMCP.tools && window.__skWebMCP.tools.get(name);
    let result;
    if (t && typeof t.execute === "function") {
      const client = { requestUserInteraction: async cb => (typeof cb === "function" ? cb() : undefined) };
      result = await t.execute(args, client);
    } else if (navigator.modelContextTesting && typeof navigator.modelContextTesting.executeTool === "function") {
      result = await navigator.modelContextTesting.executeTool(name, JSON.stringify(args));
    } else {
      return { ok: false, error: `The page doesn't offer the tool "${name}" anymore.` };
    }
    let text;
    if (result && Array.isArray(result.content)) text = result.content.map(c => (c && c.type === "text" ? c.text : `[${c && c.type}]`)).join("\n");
    else if (typeof result === "string") text = result;
    else { try { text = JSON.stringify(result === undefined ? null : result); } catch { text = String(result); } }
    text = String(text).slice(0, 8000);
    if (result && result.isError) return { ok: false, error: text.slice(0, 500) };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
  }
}
