# Sidekick product plan

Updated 2026-10-29 (v0.9.5).

## Vision
A personal assistant that knows Ulugbek and works where he works: it helps with homework, keeps track of assignments and deadlines, applies to jobs for him, and watches his screen for things worth noting. It starts as a Chrome side-panel extension and later becomes a Mac app that can see the whole screen and use other apps.

## Constraints
- **Chrome extension only** for now. No messaging channels or servers outside the browser.
- **$10/month API budget**, his own Anthropic or OpenAI key. Cheap models by default; the smart model only when it matters; the strongest only to break ties.
- **Private by default.** Data stays in Chrome storage; nothing typed into forms is learned; risky actions need his approval.

## A perfect day
Homework help with answers that are checked, not guessed. Reminders for assignments before they're due. Job applications filled from his profile, submitted with his OK. Deadlines noticed on pages he visits, without him asking.

---

## Done

| Version | What shipped |
|---|---|
| ≤ 0.7 | Side panel chat, profile + resume onboarding, memories, documents, calculator tool, web search, screen reading, browser agent (snapshot + actions), approvals, evals page |
| 0.7.3 Phase 1 | Math double-check that can't overrule a right answer without code evidence (objective/residual comparison), tie-break on the strongest model, corrections shown as a labeled block, setup blocks |
| 0.8 Phase 2 | Learned site shortcuts (replay without AI), site notes, WebMCP site tools, change-only snapshots, fill_fields, parallel actions, accessibility hints |
| 0.9 Phase 3 | Skills (procedural memory), code-checked answers with voting, memory due dates/status/origin, Markdown export/import |
| 0.9 Security pass | Zero-click leak fixes, link hijack, URL exfiltration guards, SSRF, typed-secret masking, WebMCP capture race (see SECURITY.md) |
| 0.9.1 | Live status + visible thinking, Lagrange max/min with DNE (`scanCurve`, completeness check), profile layout at half width, new chat on every open, agent keeps working when you switch tabs, blocked frames reported, MathQuill boxes, no wrapper tags in replies |
| 0.9.2 | Several tasks in one run (checklist, budgets, keep going after each submit), no more freezes (timeouts, Stop always works, "Leave site?" disarmed), saved as it goes, chat context for Agent mode, find / scroll all / web_search |
| 0.9.3 | From Claude in Chrome: notifications, agent tab group, approve the plan once, fast-model check of risky steps, local injection scan, hidden trap fields, site re-check before acting |
| 0.9.5 | TypeScript + Vite build (same behavior; load `dist/`, fixed extension ID). Before that: shared hosting domains (`*.github.io`, `*.vercel.app`, …) count as separate sites for approvals; the agent opens and switches its own tabs in the background, never yours; chat page reads, screenshots, read_url and web search have time limits and obey Stop |
| 0.9.4 | Autocomplete matching (codes, typed filtering, field's own list), pick_date calendars, row context for repeated fields; validated on the real turkishairlines.com form |

**Honest status of the browser agent:** works on the test pages; still unreliable on complex real sites (the 2026-10-29 Turkish Airlines run failed: pop-ups, coordinate guessing, wrong clicks). Chat, memory, math and the safety layer are in better shape than agent reliability.

---

## Next, in order

### Phase F: Foundation (now)
1. ~~Local git history and GitHub repo~~ (done 2026-10-31: github.com/Ulug2/sidekick, public).
2. ~~Organize the repo and migrate to TypeScript with a build~~ (done 2026-10-29: Vite, strict TypeScript, src/ by concern, all tests green throughout; ARCHITECTURE.md §4, docs/adr/).
3. Run traces: record every agent step (observation, screenshot, model call, action, result, cost); export; replay viewer.
4. Real-site benchmark: 10 tasks run on the Mac with a real model, scored per version:
   1. Turkish Airlines multi-city search IAD→IST→ALA→IAD, report the best total (stop before booking)
   2. MyOpenMath: read a problem and enter an answer into a MathQuill box (no submit)
   3. Moodle: list assignments due in the next 14 days
   4. Greenhouse job application filled from the profile, stop before submit
   5. Handshake (or LinkedIn) job search with filters, list 5 matching roles
   6. Google Flights or Kayak: cheapest round trip for given dates
   7. Amazon: compare 3 products by price and rating
   8. A long article: summarize and save key dates to memory
   9. A form with a date picker, a custom dropdown and a file upload (any real site)
   10. Gmail web: find the latest email from a sender and draft (not send) a reply
   Success = task done with ≤ 1 user intervention. Track success rate, steps, time and cost per task.

### Phase A: Agent v2 (reliability)
5. Decide build vs. fork (ADR-001): run the benchmark on Nanobrowser too.
6. Perception from Chrome (accessibility tree + layout + occlusion, all frames) with set-of-marks screenshots.
7. Deterministic action layer with preconditions and verified effects; coordinate clicks only as a zoomed last resort.
8. Planner/executor split; loop detection and pop-up policy in code; cheaper per-step cost.
9. Target: benchmark ≥ 8/10, median cost per task ≤ $0.25.

### Phase 4: Proactive
10. (13) Assignment reminders: read due dates from Moodle/MyOpenMath pages (local parsing), store as tasks, chrome.alarms + notifications.
11. (14) Cheap screen watching: local date/deadline detection on page load; fast model only on candidates; never-watch list + pause.
12. (15) Morning brief: short list when the browser opens (due soon, unfinished tasks, application statuses).
13. (16) Personal search across logged-in sites, memories, documents and past chats.
14. (16a) Record a workflow: he does a flow once, Sidekick compiles it into a shortcut (value-free), reviewable and schedulable.
15. (16b) Plain-English find: when keyword find misses, the fast model searches the element list for what was meant.

### Phase 5: Budget and reliability
16. (17) Monthly spend meter + hard cap (warn at 80%, stop smart/strongest models at 100%).
17. (18) Real-key validation: OpenAI Responses replay, Claude web search, debugger input on real sites, voice, area capture.

### Later: Mac app (v1.0)
18. (19) Electron + Swift helper; menu bar + hotkey panel; whole-screen understanding.
19. (20) Accessibility-tree actions on macOS + safety (kill switch, take-over on mouse move, app blocklist, approvals); prefer AppleScript/Shortcuts.
20. (21) MCP client (Gmail, Calendar, Notion); Chrome bridge via native messaging; cross-app tasks.
21. (22) Credential vault the model can't read; a guard agent approving internet actions; parallel sub-agents.

### Parked
- **Lighthouse for agents:** score how usable a website is for AI agents (labels, accessibility tree, stable selectors, WebMCP) and generate WebMCP tool declarations from existing forms. Possible portfolio/ACM project; shares code with agent perception.
