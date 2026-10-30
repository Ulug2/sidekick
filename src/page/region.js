// Injected into web pages with chrome.scripting.executeScript({ func }), which sends the
// function's source text: it must not use anything outside its own body (no imports, no helpers).

// Shows a crosshair overlay on the page; resolves with the dragged box (CSS pixels) or null.
// Runs inside the page, in a shadow root so the page's CSS can't interfere.
export function pickRegionInPage() {
  return new Promise(resolve => {
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .ov { position: fixed; inset: 0; cursor: crosshair; background: rgba(0,0,0,.28); }
        .box { position: fixed; border: 1.5px solid #fff; background: rgba(255,255,255,.08);
               box-shadow: 0 0 0 1px rgba(0,0,0,.4); display: none; pointer-events: none; }
        .hint { position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
                font: 500 13px/1 -apple-system, system-ui, sans-serif; color: #fff; background: rgba(20,20,20,.86);
                padding: 9px 10px 9px 14px; border-radius: 999px; display: flex; gap: 10px; align-items: center; }
        button { all: unset; cursor: pointer; padding: 5px 10px; border-radius: 999px; background: rgba(255,255,255,.14); }
        button:hover { background: rgba(255,255,255,.24); }
      </style>
      <div class="ov"></div><div class="box"></div>
      <div class="hint">Drag to capture an area <button type="button">Cancel</button></div>`;
    const ov = root.querySelector(".ov"), box = root.querySelector(".box");
    let start = null;

    const done = rect => {
      removeEventListener("keydown", onKey, true);
      host.remove();
      // Wait two frames so the overlay is gone before the screenshot is taken.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(rect)));
    };
    const onKey = e => { if (e.key === "Escape") { e.preventDefault(); done(null); } };
    addEventListener("keydown", onKey, true);
    root.querySelector("button").onclick = () => done(null);
    ov.addEventListener("contextmenu", e => { e.preventDefault(); done(null); });

    const rectFrom = e => {
      const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
      return { x, y, w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) };
    };
    ov.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      ov.setPointerCapture(e.pointerId);
      box.style.display = "block";
    });
    ov.addEventListener("pointermove", e => {
      if (!start) return;
      const r = rectFrom(e);
      Object.assign(box.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
    });
    ov.addEventListener("pointerup", e => {
      if (!start) return;
      const r = rectFrom(e);
      if (r.w < 6 || r.h < 6) { start = null; box.style.display = "none"; return; }
      done({ ...r, vw: innerWidth, vh: innerHeight });
    });
    document.documentElement.appendChild(host);
  });
}
