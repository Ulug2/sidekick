# Kickoff prompt for Claude Code

Paste everything below the line into Claude Code, started from `~/dev/sidekick`.

---

You're taking over **Sidekick**, my personal AI assistant: a Chrome MV3 side-panel extension (v0.9.4, plain JavaScript, no build). It was built in a long series of sessions with Claude in a cloud sandbox that couldn't reach real websites; that's a big reason the browser agent works on test pages but fails on real sites. From now on we work here, on my Mac, with real Chrome.

**Read first, in this order:** `CLAUDE.md`, `docs/PRODUCT_PLAN.md`, `docs/ARCHITECTURE.md`, `docs/LESSONS.md`, `docs/SECURITY.md`. Skim `docs/RESEARCH_NOTES.md`, `docs/USER_GUIDE.md` and `tests/README.md`.

Work through these steps in order. Stop where I say **checkpoint**, show me what you found, and wait for my OK before continuing.

### 1. Baseline
- Run `npm install`, `npx playwright install chromium`, `npm test` and `npm run test:chrome`. Report the counts (expected: about 530 jsdom checks and 54 real-Chrome checks, all passing). If anything fails on my machine, find out why before touching code.
- Initialize a **local** git repo and commit the untouched baseline (`git init`, then commit everything with a message like "Baseline v0.9.4"). Don't create anything on GitHub yet.

### 2. Analyze the codebase yourself and write `docs/ASSUMPTIONS.md`
Don't just trust the docs; read the code. In that file, write down:
- How you understand the system works, in your own words (short).
- Where the docs and the code disagree.
- What you think is fragile, dead, duplicated or over-complicated (with file and function names).
- Risks for the TypeScript migration, especially: functions in `extension/page-agent.js` are injected with `chrome.scripting.executeScript({ func })` and must stay self-contained; the tests load raw source files into jsdom (`tests/helpers.js loadScripts`); one shared global scope across ~20 side-panel scripts; vendored libraries in `extension/vendor/`.
- Your own assumptions and opinions where you'd do something differently from `docs/ARCHITECTURE.md`, with your confidence (high/medium/low).
- Questions you need me to answer.

**Checkpoint 1:** summarize ASSUMPTIONS.md for me in a few bullets and ask your questions.

### 3. Plan the reorganization and the TypeScript migration
Propose, in `docs/MIGRATION_PLAN.md`:
- The target folder layout (start from ARCHITECTURE.md §3; change it if you have good reasons).
- Build tooling (ARCHITECTURE.md ADR-002: WXT vs. plain Vite; recommend one and say why).
- How the existing test suites keep running during the migration (they must stay green after every step), and how they move to Vitest + Playwright over time.
- The order of steps, small enough that each can be tested and committed on its own.
- What you will NOT change (behavior, model IDs in `DEFAULT_SETTINGS`, prompts, security rules).

**Checkpoint 2:** show me the plan and wait for my OK.

### 4. Execute the migration
- Behavior-preserving only. No new features, no prompt changes, no "while I'm here" refactors beyond what the plan says.
- Keep every test green after each step; run `npm test` (and `npm run test:chrome` after any change to the manifest, page scripts, the side panel, or the agent). Commit after each step with a clear message.
- TypeScript: `strict` mode, with `allowJs` only while files are still being converted. Add types for storage (one schema), messages between contexts, model calls, tool calls and page snapshots.
- Page scripts (`page-agent.js` and friends) become separately bundled, self-contained scripts injected with `files: [...]` (or stay closure-free if that's simpler; explain the choice).
- The build output must load in Chrome (Load unpacked → `dist/` or whatever the tool produces). After the last step, load it in my Chrome yourself if you can (Claude in Chrome), or tell me exactly how to check it.
- Update `CLAUDE.md`, `docs/ARCHITECTURE.md`, `tests/README.md` and `package.json` scripts to match the new layout. Add `docs/adr/` with the decisions you made.

**Checkpoint 3:** report what changed, the test counts before and after, anything you couldn't verify, and anything that behaves differently.

### 5. GitHub
Walk me through putting this on GitHub step by step; don't do it for me without asking. Ask me first: repo name (suggest `sidekick`), private or public (I'd lean private for now), and whether I have the GitHub CLI (`gh`) installed and logged in. Then give me the exact commands (`gh repo create ...` or the website route plus `git remote add` and `git push`). Before the first push, check that nothing secret or personal is committed (API keys, `.env`, real personal data; the resumes in `tests/fixtures/` are a fictional "Jordan Example", so they're fine) and that `.gitignore` covers `node_modules`, build output and test artifacts.

### Ground rules for all of this
- Follow the rules in `CLAUDE.md` and `docs/LESSONS.md`. The security invariants in `CLAUDE.md` must never regress.
- When you report: plain words, what broke and why, what you changed, what you didn't test (real API keys, real sites, my accounts).
- Don't spend my API budget: the tests fake the model APIs; don't run anything that calls Anthropic or OpenAI for real without asking.
- After the migration, the next project is the run-trace recorder and the real-site benchmark (`docs/PRODUCT_PLAN.md` Phase F), then agent v2. Don't start those until I say so, but note anything in the code that will matter for them.
