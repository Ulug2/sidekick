# Architecture decision records

| ADR | Decision | Status |
|---|---|---|
| [001](001-agent-core-build-or-fork.md) | Build our own agent core or fork Nanobrowser | Open: decided by the Phase F benchmark |
| [002](002-build-tool.md) | Plain Vite with a hand-written manifest, not WXT | Accepted, 2026-10-29 |
| [003](003-perception-source.md) | Perception from CDP (accessibility tree + DOMSnapshot) vs. the in-page walker | Open: agent v2 |
| [004](004-ui-framework.md) | Keep vanilla DOM code; no React for now | Accepted, 2026-10-29 |
| [005](005-page-scripts.md) | Injected page functions stay `func`-injected and closure-free, checked on every build | Accepted, 2026-10-29 |
| [006](006-test-bridge.md) | The jsdom suites run against test bundles of the same modules | Accepted, 2026-10-29 |
| [007](007-extension-key.md) | A fixed public key in the manifest pins the extension ID | Accepted, 2026-10-29 |
| [008](008-typescript-strictness.md) | `strict` everywhere; explicit `any` only at untyped edges (page DOM, site objects, math.js nodes, UI lookups) | Accepted, 2026-10-29 |
