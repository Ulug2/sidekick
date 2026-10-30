# ADR-008: TypeScript strictness

Status: accepted (2026-10-29).

`strict: true` for all of `src/` (no `allowJs`; the only JavaScript file is `content/webmcp-capture.js`, copied byte for byte). Typed precisely: storage (`core/storage/schema.ts`), model calls (`core/llm/types.ts`), chat turn and review (`assistant/types.ts`), the agent (`agent/types.ts`: page snapshots, page actions and results, elements, tool outcomes, agent state, the UI contract), the context-menu hand-off (`SessionSchema.pending`).

Explicit `any` is allowed at untyped edges only: page DOM inside injected functions, objects a site hands us (WebMCP tools), math.js/nerdamer expression nodes in the calculator, JSON written by a model (tool arguments), and DOM lookups in UI code (`$` returns `any`; narrowing uses type-only `!` and `as any`). The conversion added types only: the emitted JavaScript is the same code. UI typing should be tightened when those files are next changed for real.
