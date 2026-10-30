# ADR-004: UI framework

Status: accepted (2026-10-29).

Keep the vanilla DOM code (now TypeScript, split into modules) for the migration and for agent v2. The UI works and isn't the bottleneck; React would be a rewrite with its own risks. Revisit if UI work becomes the main cost.
