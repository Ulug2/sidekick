# Sidekick: research notes and direction (2026-10-27)

## Ulugbek's goals (stated)
- Perfect Jarvis day: helps with homework; reminds about assignments; applies to jobs for him; monitors the screen while he works and notes deadlines or anything useful.
- Stays a Chrome extension only for now (no Telegram/iMessage/other channels).
- Budget: $10/month total API spend.

## What the field does (Oct 2026)
- Dot (New Computer): structured memories with status + date fields; hybrid retrieval (semantic + keyword + metadata). Shut down Oct 5, 2025.
- Meta Muse (Sep 2026): goal → steps, parallel sub-agents, background tasks, credential vault the model can't read, Sentinel guard agent approves internet actions. Criticized for reading email without permission.
- Poke (Mar 2026, bought by Cognition Jul 2026): one personality agent talks to the user, execution agents work behind it; cron/email triggers; witty, never sycophantic. Unprofitable due to cost.
- OpenClaw: memory as Markdown files (SOUL.md, USER.md, MEMORY.md, daily logs) + hybrid search 70% vector / 30% BM25; flush to disk before compaction; heartbeat every 30 min with a cheap model + checklist, silent if nothing, escalate if needed; workflows saved as scripts.
- Hermes Agent: SKILLS = procedural memory. After 5+ tool calls, an error recovery, or a user correction, write/patch a skill file. Only skill names in the prompt; full text loads on demand. Prompt memory capped (~3.5k chars).
- ChatGPT/Claude/Gemini: stated facts + background consolidation ("dreaming", nightly wiki, Letta sleep-time compute with a bigger model). ChatGPT Pulse: overnight research, finite set of morning cards, expire in 24h.
- Mac: OpenAI bought Sky (acts via AppleScript/shell/app integrations). Raycast Screen Awareness captures accessibility text + selection + focused field + screenshot, on demand only. Peekaboo = open-source macOS screenshot + GUI control CLI/MCP (could replace much of the Swift helper).
- OSWorld: Fable 5 86%, Opus 5 83%, GPT-5.6 Sol 83% (Yutori tracker). Model choice > framework.
- Structured state beats pixels: API/script > accessibility tree/DOM > screenshot.
- Self-correction can flip right answers to wrong (DeepMind). Programs-as-verifiers + majority vote beats plain voting for all 13 models tested (arXiv 2410.12608).
- Prompt injection: best defenses still ~1–2% attack success. Keep approvals + fencing.

## Sidekick roadmap from this research (ordered)
0. v0.7.3 double-check fixes — see NEXT_STEPS.md.
1. SKILLS (procedural memory): auto-write/patch skills after corrections or hard tasks (e.g. "MyOpenMath optimization recipe", "MATH 211 answer format", "Greenhouse application flow"). Names in prompt, body on demand.
2. Verified math by voting: 2–3 independent solves, each must produce a calc program; vote only among program-confirmed answers; compare objective/residual. Only for hard problems (budget).
3. Assignment reminders: chrome.alarms heartbeat; read Moodle/MyOpenMath due dates from pages he visits (local parsing, no LLM), chrome.notifications; short morning brief when the browser opens.
4. Screen watching (cheap): on page load/visibility, extract text locally, regex/heuristics for dates/deadlines/"due", call the fast model only on candidates; save as structured memories (status, due date, source URL, stated vs inferred). Never-watch site list; pause toggle.
5. Memory upgrades: status/date/provenance fields; background reflection on the smart model; export as readable files (ports to Mac app).
6. Job applications: skill-based flows per ATS (Greenhouse, Lever, Workday), applications log already exists.
7. Later (Mac): MCP client; Peekaboo-style helper.

## $10/month budget implications
- Default to the fast model (Haiku 5.5 / gpt-5.6-luna); smart only when routed; Opus/astra only for tie-breaks.
- Screen watching and reminders mostly local (no LLM) — LLM only on detected candidates.
- Heartbeat with no LLM call when nothing changed.
- Prompt caching on; cap images (downscale), cap voting to hard math.
- Add a monthly spend meter + hard cap in Settings (usage tracking already exists per model per day).

## Claude in Chrome: what it does and what to borrow (researched 2026-10-28)
Official sources: Anthropic support "Getting started with Claude in Chrome", "Claude in Chrome is generally available" blog, "Prompt injection defenses" research post. Tool details come from third-party reverse-engineering (unofficial).
- Perception: its own accessibility tree (read_page, ref ids), screenshots as fallback; find = natural-language search by a nested small model over the full tree; get_page_text; form_input by ref; CDP for trusted input.
- Safety: RL training against injections; probes scan every tool result and warn the model; a classifier reviews each action (navigate, type) against the user's request before it runs (same as Claude Code auto mode); per-domain permissions (once / always), domain re-checked right before each acting step; blocked categories (finance, adult, piracy); plan mode (approve domains + 3–7 steps once). Reported attack success: 23.6% → 11.2% (2025 preview) → ~1% (Opus 4.5) → 0% for Opus 5/Sonnet 5 with probes + classifier on the current eval.
- Features: tab groups (your tabs vs Claude's tabs, colored), works in background with notifications, "/" saved-prompt shortcuts, workflow recording (you demonstrate, it repeats), scheduled tasks, 1Password sign-in without seeing passwords, GIF recording of runs, console/network reading for developers.
- Closed source: borrow ideas, not code. MIT clean-room clone exists (noemica-io/open-claude-in-chrome) but removes the domain blocklist.
Candidates for Sidekick: action-check by the fast model on domain changes and personal-data typing; local injection scan of snapshots; tab group for agent tabs; notifications when approval is needed; approve-the-plan mode for multi-job runs; record-a-workflow → shortcut; NL fallback for find; domain re-check before acting.

## Checked for the v1 plan (2026-11-10)

- **H-1B (as of early Oct 2026 sources):** the wage-weighted lottery took effect 2026-02-27 and runs the FY2027 season (Level I = 1 entry, Level IV = 4). The $100,000 fee (Proclamation 10973) applies to petitions for people outside the US / consular processing, not to change-of-status from F-1 inside the US; a Massachusetts federal court vacated the implementing guidance on 2026-06-08 and the appeals court refused a stay on 2026-07-24, while the proclamation was extended to 2027-09-21: legally unsettled. A $103,265 cap-petition fee was proposed 2026-08-24 (comments closed 2026-09-24), not final. OPT (12 months) + STEM OPT (24 months, E-Verify employer) cover a May 2027 start. Sources: tracreports.org/reports/768, budgetmodel.wharton.upenn.edu (2026-08-03), vorys.com FY2027 update, gujjuiimmigration.com.
- **DOL LCA disclosure data:** quarterly public disclosure files for FY2026 (Q1 released Dec 2025, Q3 2026-08-14) at dol.gov/agencies/eta/foreign-labor/performance; large xlsx with record layouts. Plan: a build-time script compacts employer → certified-LCA count into a small JSON shipped with the extension and refreshed monthly.
- **Microsoft Graph at a university tenant:** most schools restrict user consent for third-party apps; Microsoft's default consent policy now requires admin consent for mail scopes (Mail.Read among them, Nov 2025 change); "User assignment required" on the enterprise app can force admin approval even after tenant consent; Mail.ReadBasic is sometimes allowed where Mail.Read isn't. Expect to need Gettysburg IT, or fall back to forwarding to Gmail / reading Outlook web. Sources: Microsoft Q&A and Tech Community threads, timetoreply and Trinity College guidance.
- **Canada:** ESDC cut the Global Talent Stream Category A referral partners (list revised 2026-09-15; 28 vs 41 partners depending on the source); Category B is occupation-based with no employer list. The positive-LMIA employer list is an ESDC dataset on open.canada.ca (to confirm the exact dataset and refresh cadence in Phase 4). Sources: cicnews.com (2026-09), immigration.ca, moving2canada.com.
- **Model IDs and prices (Claude API reference, 2026-11-10):** no `claude-fable-5-2`; Fable 5.1 `claude-fable-5-1` $10/$50 (cache read $0.25); Opus 5.5 $4/$20; Sonnet 5.5 $2/$10; Haiku 5.5 $0.10/$0.50 (long-prompt tier above 100K). Fable 5.1: thinking always on, effort low–max, no forced tool choice, 30-day retention required, refusal fallbacks available. Anthropic has no embeddings endpoint.
