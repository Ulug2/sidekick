# Lessons: mistakes that reached Ulugbek, and the rules that stop them coming back

Each entry: what you saw → the real cause → the fix → the rule for future work → the test that guards it.
Read this before starting a new phase.

General rules that came out of these: design for the long version of a task; every outside call has a timeout and obeys Stop; save as you go; never skip silently; strip internal markup in code; test at real widths and in real Chrome.

## v0.9.1 (2026-10-28)

### 1. You couldn't see what Sidekick was doing
- **Cause:** Claude 5.x models think with `display: "omitted"` by default, so no thinking came back; tool chips only showed tool calls, and the long silent stretches (double-check, tie-break, reading the page) had no status at all.
- **Fix:** request `thinking: { type: "adaptive", display: "summarized" }` (OpenAI: `reasoning.summary: "auto"`), stream it into a live status line ("Thinking", "Reading the problem from the page", "Double-checking the answer"…), collapse to "Thought for Ns" with the full thinking inside, saved with the chat. Both providers fall back silently if a model or account rejects the setting.
- **Rule:** every step that can take more than ~2 seconds must say what it's doing. When adding a new step (a tool, a check, a wait), add its status label in the same change. Check API defaults for each new model generation; don't assume a feature is on.
- **Tests:** fixes-test 1 (9 checks), real-chrome 11.

### 2. Lagrange problem: only one part right ("max and min are both 8103.0839")
- **Cause:** Lagrange multipliers only give *candidates*. The constraint x³+y³=54 is unbounded, f = e^{xy} → 0 along it but never reaches 0, so the minimum doesn't exist (DNE). Sidekick reported the one candidate as both answers, and the double-check only confirmed the one value it was shown.
- **Fix:** prompt rule (candidates ≠ answers; decide whether each extreme is attained; answer every part; DNE when not attained); new calculator tool `scanCurve(f, constraint, x, y)` that walks the whole curve and says whether each extreme is reached or only approached; checker must cover every part; code check `extremaProblem()` catches "same value for max and min" or a missing part and forces a third solve.
- **Rule:** for any multi-part question, compare the number of parts asked with the number answered, in code, before showing. "Verified" must mean every part was checked, not just that the given value is correct. Solve the test problem myself first so I know the target (here: max e⁹ ≈ 8103.0839 at (3,3), min DNE).
- **Tests:** fixes-test 2 (5 checks), eval `lagrange-dne`.

### 3. Profile page: section menu covered the profile at half-screen width
- **Cause:** CSS order. The narrow-screen media query came *before* the base `.toc` rules, so the base rules won and the sticky menu kept its desktop layout on top of the content.
- **Fix:** media query moved after the base rules; the menu becomes a solid sticky row under the top bar, and jumped-to sections start below it (`scroll-margin-top`).
- **Rule:** media queries go after the rules they override. Test every page at the widths people actually use: full, half (≈760px with the panel open), and panel width (340–420px).
- **Tests:** real-chrome 11 (760px: no overlap, jumped section starts below the menu).

### 4. Reopening Sidekick continued the old chat
- **Cause:** the panel restored `lastChatId` from session storage on open.
- **Fix:** every open starts a new chat; the chat is saved after each message and again on close/reload (`pagehide`), including a reply that was still streaming.
- **Rule:** "save" and "restore" are separate decisions; ask which one the user wants. Closing must never lose the last message.
- **Tests:** fixes-test 4, v4-test, e2e-test, real-chrome 11.

### 5. Switching tabs broke agent mode
- **Causes (three):** (a) a tab you opened yourself (Ctrl+T) counts as "opened by" the agent's tab in Chrome, so the agent followed it; (b) debugger input can stall in a background tab; (c) screenshots switched you back to the agent's tab and could photograph the wrong one.
- **Fix:** only follow a new tab opened within 4 s of the agent's own click/key press, never Chrome's new-tab page; in a background tab use page events instead of the debugger, with a 4 s timeout that falls back automatically; screenshots of a background tab are refused with an explanation instead of stealing focus; you're told once that it keeps working in the background.
- **Rule:** assume the user keeps using the browser while the agent works. Never change which tab the user is looking at. Any call into Chrome that can hang gets a timeout and a fallback.
- **Tests:** fixes-test 5 (5 checks), real-chrome 11.

### 6. Couldn't use MyOpenMath inside Moodle, and didn't say why
- **Causes:** frames Chrome didn't let Sidekick into were skipped silently; MyOpenMath answer boxes (MathQuill) aren't normal inputs, so they weren't listed at all.
- **Fix:** every visible frame Sidekick can't read is reported by site ("Can't see inside an embedded frame (from www.myopenmath.com)"), in chat and in agent mode, with what to do; a page Chrome blocks entirely says so with the setting to change. Math boxes are listed as `textbox:math` with their label and value; typing clears them like a person (End, Backspace) and falls back to the hidden answer field.
- **Rule:** never skip silently. Anything Sidekick can't read or do is reported with the site and a next step. Test on the markup the real sites use (Moodle LTI iframe, MathQuill), not just plain forms.
- **Tests:** fixes-test 6 (6 checks).

### 7. `<untrusted_content>` tags showed up in a reply
- **Cause:** the model copied the security fence around the selected text into its answer, and the tag isn't valid HTML, so the closing tag rendered as text.
- **Fix:** prompt rule never to copy the fence; `stripWrappers()` removes fence and internal tags from every reply before it's shown, saved or copied.
- **Rule:** anything internal (fences, XML tags for the pipeline) must be stripped in code at the output boundary; a prompt rule alone is not enough.
- **Tests:** fixes-test 7 (3 checks), real-chrome 11.

## v0.9.2 (2026-10-28): the agent and several tasks

### 8. "Apply to 4 jobs" applied to 1, then stopped and froze; the run wasn't saved
- **Causes:** (a) a reply without a tool call ended the run, and the model ended with "I'll click Submit. Would you like to proceed?"; (b) one 40-step budget for the whole request; (c) no timeouts: a page showing "Leave site?" or an alert(), or a silent AI connection, made Sidekick wait forever, and Stop couldn't interrupt a hung page call; (d) the chat was saved only when the run ended, so a freeze lost it.
- **Fix:** a checklist tool (plan) the user sees; a reply without tools is sent back to work while items are open or when it asks in plain text (questions go through ask_user, submits through the approval card); 40 steps + 30 per extra task (max 160); 15 s timeout on every page call, 90 s silence → retry once → clear error; Stop interrupts page calls; leaving a page switches off its "Leave site?" prompt; each application in its own tab; the run is saved after every step.
- **Rule:** design for the long version of the task (4 jobs, not 1). Every await on something outside our code (page, network, Chrome) has a timeout and responds to Stop. Save progress as it happens, never only at the end. A model ending its turn by asking a question is not "done".
- **Tests:** multitask-test 1–2, real-chrome 12. Real Chrome caught one wrong assumption: blocking the page's own beforeunload handlers with a capture listener doesn't work (they run in registration order); the fix makes their cancel do nothing instead.

### 9. "You know which position I need": every Agent-mode message started from zero
- **Cause:** Agent mode sent only the newest message; the earlier chat (the roles it had just listed, the company) never reached the agent.
- **Fix:** the last 12 messages, step lists and pinned notes go with every agent task (fenced as data, since replies can quote web pages); the prompt says to use them and, with no role named, to pick from the profile's target roles and say which.
- **Rule:** any new entry point to the model gets the conversation. Test follow-ups ("that one", "the backend one"), not just first messages.
- **Tests:** multitask-test 6, real-chrome 12.

### 10. Slow, one-screen-at-a-time scrolling; guessed higgsfield.com
- **Cause:** the snapshot already lists the whole page, but the prompt told the agent to scroll when unsure, and it had no way to search the page or the web.
- **Fix:** find (searches every element and all text on the page and in frames at once, even past the 300-element snapshot), scroll "all" (loads lazy lists in one step), web_search (refuses queries with your personal details); prompt says don't scroll to read.
- **Rule:** give the agent the tool a person would use (Ctrl+F, a search engine) instead of making it walk.
- **Tests:** multitask-test 3–4, real-chrome 12.

## v0.9.4 (2026-10-29): "It still can't even find tickets" (Turkish Airlines multi-city)

### 11. Forms built from widgets: autocompletes, calendars, repeated rows
- **What happened:** 23 steps, then it gave up. It rejected the right airport ("Dulles International Airport(IAD)") because it wanted the exact words "Washington DC (IAD)"; it typed the whole phrase into a search box that only matches a city or code; it offered header links ("Corporate Club", "EN-US") as options; it had no way to work a calendar; every leg's fields had the same labels, so it couldn't tell leg 1 from leg 2; and it guessed screen coordinates without a fresh screenshot.
- **Causes:** exact-text option matching; options collected from the whole page; no date-picker tool; no row context for repeated labels. Found by inspecting the real site in Chrome: one shared listbox (aria-controls), options appear only after typing, react-calendar days labelled "December 10 Thursday, 2026", and the calendar opens by itself after you pick the destination (so clicking "Dates" again closed it, the cause of the first calendar failure on the real site).
- **Fix:** select_option scores matches (same airport code wins, then wording), uses only the field's own list, and types the code, then the name, to make suggestions appear; pick_date opens the calendar only if none is showing, moves month by month (into next year) and clicks the day by its label; repeated fields carry row: "2. Flight"; prompt covers dates without a year, add-on pricing ("+USD 45") and never booking.
- **Rule:** before fixing a site failure, look at the real site's markup and behavior (in Chrome, read-only) and build a test copy that reproduces the failure without the fix. Validate the fix on the real site too. Match the way people read options (codes, close wording), not exact strings.
- **Tests:** forms-test (12) on fixtures/airline.html, which fails 4 checks with the old calendar code; real-chrome 14; and on the real turkishairlines.com, all three legs were filled through Sidekick's own page code (IAD→IST Dec 10, IST→ALA Dec 15, ALA→IAD Jan 25 2027).

## Earlier lessons (v0.7–v0.9)
- **A double-check must not overrule a right answer without evidence** (v0.7.2 pipeline problem). Replacements need a code check (objective or residuals) under both setups.
- **Examples in prompts anchor the model.** Use neutral numbers, never the real answer.
- **Learned data must never contain what you typed** (shortcuts, site notes): store which profile field, never the value.
- **Global switches have side effects**: parallel tool calls are for the agent only.
- **jsdom isn't Chrome.** The WebMCP load-time race only showed up in real Chromium; every release runs the real-Chrome suite too.
- **Say what wasn't tested with real accounts and keys.**
