// Runs in every page's own JavaScript world at document_start. If the browser (or a site's
// polyfill) provides navigator.modelContext — WebMCP, the proposed standard for websites to
// offer tools to AI agents — this records the tools the site registers, so Sidekick's agent can
// call them instead of clicking through the page. It never creates navigator.modelContext,
// never calls anything by itself, and sends nothing anywhere. On pages without WebMCP it adds
// nothing to the page at all, so sites can't use it to detect that Sidekick is installed.
(() => {
  let tools = null;
  const install = mc => {
    if (!mc || mc.__skWrapped || window.__skWebMCP) return;
    tools = new Map();
    try {
      Object.defineProperty(window, "__skWebMCP", { value: { tools }, configurable: false, enumerable: false });
      const reg = typeof mc.registerTool === "function" ? mc.registerTool.bind(mc) : null;
      const unreg = typeof mc.unregisterTool === "function" ? mc.unregisterTool.bind(mc) : null;
      const provide = typeof mc.provideContext === "function" ? mc.provideContext.bind(mc) : null;
      const clear = typeof mc.clearContext === "function" ? mc.clearContext.bind(mc) : null;
      if (reg) mc.registerTool = function (tool, ...rest) {
        const r = reg(tool, ...rest);
        if (tool && tool.name) tools.set(tool.name, tool);
        return r;
      };
      if (unreg) mc.unregisterTool = function (name, ...rest) {
        tools.delete(typeof name === "string" ? name : name && name.name);
        return unreg(name, ...rest);
      };
      if (provide) mc.provideContext = function (ctx, ...rest) {
        const r = provide(ctx, ...rest);
        tools.clear();
        for (const t of (ctx && ctx.tools) || []) if (t && t.name) tools.set(t.name, t);
        return r;
      };
      if (clear) mc.clearContext = function (...rest) { tools.clear(); return clear(...rest); };
      Object.defineProperty(mc, "__skWrapped", { value: true });
    } catch {}
  };
  const check = () => { try { if (navigator.modelContext) install(navigator.modelContext); } catch {} return !!tools; };
  if (check()) return;
  // A site's script (or a polyfill) may install navigator.modelContext while the page loads and
  // register tools in its very next script. Mutation callbacks run right after each page script
  // finishes, so this wraps the API before the next script can register anything. The observer
  // is invisible to the page and stops once the page has loaded.
  const mo = new MutationObserver(() => { if (check()) mo.disconnect(); });
  try { mo.observe(document, { childList: true, subtree: true }); } catch {}
  const stop = () => { check(); mo.disconnect(); };
  document.addEventListener("DOMContentLoaded", () => setTimeout(stop, 0), { once: true });
  window.addEventListener("load", stop, { once: true });
})();
