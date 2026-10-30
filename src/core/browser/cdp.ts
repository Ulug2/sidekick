// Real ("trusted") input for agent mode through Chrome's debugger protocol. Sites can't tell
// these clicks and keystrokes apart from yours, which fixes pages that ignore simulated
// events (React widgets, rich editors, canvas apps). Chrome shows a "Sidekick started
// debugging this browser" bar while it's attached; cancelling that bar falls back safely.
import { shrinkImage } from "./screen.js";

export class TrustedInput {
  target: chrome.debugger.Debuggee;
  attached: boolean;
  onDetach: (source: chrome.debugger.Debuggee, reason: string) => void;

  constructor(tabId: number) {
    this.target = { tabId };
    this.attached = false;
    this.onDetach = (source, reason) => {
      if (source.tabId === this.target.tabId) this.attached = false;
    };
  }

  static async attach(tabId: number): Promise<TrustedInput | null> {
    if (!chrome.debugger) return null;
    const t = new TrustedInput(tabId);
    try {
      await chrome.debugger.attach(t.target, "1.3");
    } catch (err) {
      // Already attached (e.g. DevTools open) or a page Chrome protects.
      return null;
    }
    t.attached = true;
    chrome.debugger.onDetach.addListener(t.onDetach);
    return t;
  }

  // Chrome pauses rendering in background tabs, and some debugger commands then wait until the
  // tab is visible again. A time limit turns that wait into an error the agent can recover from.
  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 4000): Promise<any> {
    if (!this.attached) throw new Error("Trusted input isn't available right now.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`The page didn't respond to ${method} (the tab may be in the background).`), { name: "TrustedInputTimeout" })), timeoutMs); });
    try { return await Promise.race([chrome.debugger.sendCommand(this.target, method, params), limit]); }
    finally { clearTimeout(timer); }
  }

  // Coordinates are CSS pixels relative to the top of the visible page.
  async click(x: number, y: number, { clickCount = 1 } = {}): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount });
  }

  // Types into whatever has focus, like a real keyboard (or an IME commit).
  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async key(key: string): Promise<void> {
    const K = ({
      Enter: { code: "Enter", keyCode: 13, text: "\r" },
      Tab: { code: "Tab", keyCode: 9 },
      Escape: { code: "Escape", keyCode: 27 },
      Backspace: { code: "Backspace", keyCode: 8 },
      ArrowDown: { code: "ArrowDown", keyCode: 40 },
      ArrowUp: { code: "ArrowUp", keyCode: 38 },
      Space: { code: "Space", keyCode: 32, text: " ", key: " " },
      End: { code: "End", keyCode: 35 },
      Home: { code: "Home", keyCode: 36 }
    } as Record<string, { code: string; keyCode: number; text?: string; key?: string }>)[key];
    if (!K) throw new Error(`Unsupported key ${key}`);
    const base = { key: K.key || key, code: K.code, windowsVirtualKeyCode: K.keyCode, nativeVirtualKeyCode: K.keyCode };
    await this.send("Input.dispatchKeyEvent", { type: K.text ? "keyDown" : "rawKeyDown", ...base, ...(K.text && { text: K.text, unmodifiedText: K.text }) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  // Screenshot of the viewport, scaled so 1 image pixel = 1 CSS pixel (matches click coordinates).
  async screenshot(): Promise<{ dataUrl: string; width: number; height: number }> {
    const metrics = await this.send("Page.getLayoutMetrics");
    const vp = metrics.cssLayoutViewport || metrics.layoutViewport;
    const { data } = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 75 });
    const shrunk = await shrinkImage("data:image/jpeg;base64," + data, 99999, vp.clientWidth);
    return { dataUrl: shrunk.dataUrl, width: vp.clientWidth, height: vp.clientHeight };
  }

  async detach(): Promise<void> {
    chrome.debugger.onDetach.removeListener(this.onDetach);
    if (this.attached) {
      this.attached = false;
      try { await chrome.debugger.detach(this.target); } catch {}
    }
  }
}
