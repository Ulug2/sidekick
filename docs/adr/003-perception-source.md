# ADR-003: Perception source for agent v2

Status: open (2026-10-29).

Options: CDP `Accessibility.getFullAXTree` + `DOMSnapshot` (Chrome's own names, roles, boxes, paint order, cross-origin frames; needs the debugger attached and shows Chrome's "debugging" bar) vs. an improved in-page walker (no bar, no cross-origin frames).

Notes so far: trusted input already attaches the debugger, so the bar is already shown during agent runs. In un-instrumented Chromium, debugger mouse input times out in a background tab while typing, keys and `Page.captureScreenshot` work (2026-10-29 probe). Decide with the Phase F benchmark; likely CDP first, the in-page walker as fallback.
