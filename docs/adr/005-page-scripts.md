# ADR-005: Injected page functions stay `func`-injected and closure-free

Status: accepted (2026-10-29).

## Context
`chrome.scripting.executeScript({ func })` sends a function's source text; anything it references outside its body is undefined in the page. The alternative, `files: [...]`, can't pass arguments, and a file injected into the page's MAIN world would leave globals the page can see (fingerprinting).

## Decision
- Every injected function lives in `src/page/` (one concern per file: snapshot, act, webmcp, read, region, replace-selection, leave-prompt) and may import types only.
- They are still passed as `func`.
- `scripts/check-build.mjs` parses the built `dist/assets/*.js` and fails the build if an exported `src/page` function references a module-level name or an unknown global.
- The jsdom and real-Chrome suites run them from their `toString()` inside the page, as Chrome does.

## Consequences
No shared helpers between page functions (small duplication, e.g. the secret-field regex, is accepted). The build target must stay modern and unminified, or the check must be re-validated.
