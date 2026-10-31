# ADR-009: Run traces in chrome.storage, screenshots stored separately

Status: accepted (2026-10-31).

Every agent run is recorded (`src/agent/trace/`) so failures can be replayed and the Phase F benchmark can score runs by steps, time and cost.

- **Where:** `chrome.storage.local`, like chats: `traceIndex` (one line per run), `trace:<id>` (the run without images, rewritten after every change, so it stays small) and `traceShot:<id>:<n>` (JPEG screenshots, ~50 KB, written once). The last 30 runs are kept. IndexedDB would hold more but adds a second storage system; revisit if traces outgrow this.
- **What:** per step, before the model call: the tab's URL and title, a screenshot, and any message sent to the model (the task with the first page, nudges). Then the model's reply, thinking summary and tool calls, each action with its arguments, label, result and time, approvals and questions (saved while they wait), and every other model call of the run (safety checks, site notes).
- **Cost:** `modelCall` reports each call to a watcher keyed by the run's Stop signal (`watchModelCalls`), so side calls are counted without passing a recorder around. Dollars come from `core/llm/prices.ts`; models without a price make the total "unknown", never a guess.
- **Screenshots:** with the debugger attached (real clicks on) Chrome captures even background tabs; otherwise only the visible tab. The recorder never attaches the debugger by itself and gives up after 4 s.
- **Export:** one JSON file with the screenshots inside; secrets masked again. Imported files are validated, shown as text only, and keep only JPEG/PNG images.
- **Not recorded:** chat turns without the agent (their trace is already saved with the chat message).
