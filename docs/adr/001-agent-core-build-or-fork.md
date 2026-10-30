# ADR-001: Build our own agent core, or fork Nanobrowser

Status: open (2026-10-29).

Nanobrowser is an Apache-2.0 Chrome extension agent (TypeScript, chrome.debugger, planner/navigator, several providers). Sidekick's value is the personal layer (profile, memory, homework, deadlines, applications) and the safety layer; the agent core is what fails on real sites.

Decision: run the same 10 Phase F benchmark tasks on both and decide on the numbers. Adopt their core only if it's clearly better, and keep Sidekick's safety gates (approvals, fencing, secret refusal, site rules) either way.
