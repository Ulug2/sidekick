# Costs: what the v1 design would spend per month, and how routing keeps it down

Updated 2026-11-10. Prices are Anthropic list prices per million tokens (checked 2026-11-10 through the Claude API reference in this session): Fable 5.1 $10 in / $50 out / $0.25 cache read; Opus 5.5 $4 / $20 / $0.20; Sonnet 5.5 $2 / $10 / $0.20; Haiku 5.5 $0.10 / $0.50 / $0.01. OpenAI (his current key): GPT-5.6 Terra $2 / $12 / $0.20, Luna $0.20 / $1.20 / $0.02. Measured in this codebase: one agent step on a real site costs $0.008–0.03 on Terra/Sonnet class (benchmark 2026-11-09: 18 steps for $0.14 on MyOpenMath, 5 for $0.05 on Moodle, 2 for $0.065 on Amazon) and about a tenth of that on Luna/Haiku class with prompt caching at 0.7–0.85 hit rate.

**There is no `claude-fable-5-2` model ID in the current model list.** The most capable model is Claude Fable 5.1 (`claude-fable-5-1`); the costs below use it for the brain. If a 5.2 ships, it lands in one line of `src/core/llm/models.ts`.

## Routing strategy

| Role | Model | What it does | Why |
|---|---|---|---|
| Brain (plan, rank, review, decide, talk to him) | Fable 5.1 | the 8 AM batch (rank ~60 eligible jobs), reviewing worker results that failed or look odd, Needs-You triage, email replies that matter, anything he asks the chat | judgment; a few calls a day, each with a compact, cached world state |
| Worker: browser (apply, read course sites, read Outlook web) | Sonnet 5.5 (or Haiku 5.5 for plain forms; Terra/Luna on the OpenAI key) | one agent run per application; course-site reads | the measured per-step cost; escalates to the brain only on failure |
| Worker: writer (cover letters, open-ended answers, email drafts) | Sonnet 5.5 | one or two calls per letter | voice checks run in code |
| Worker: classifier/extractor (email triage, date extraction, question matching, eligibility sentences the regexes miss) | Haiku 5.5 | many small calls | cents per hundred |
| Code, no model | — | eligibility rules, sponsor lookups, batch picking, scheduling, spend cap, answer-bank prefilter (BM25) | free |

Rules: every call carries the stable prefix (system prompt, tool list, fact store) first and the volatile part last, so caching holds; the world state is sent as a short summary (under 2K tokens), never the raw job list; workers never see the whole memory, only the slice the task names; the brain never runs in a loop, it answers one planning question and stops.

## Per workstream, per month

Assumptions: 20 applications a day, 25 days; email 60 messages a day on two accounts; three course sites read twice a day; chat as today (~10 messages a day).

| Workstream | Calls | Model | Tokens | $/month |
|---|---|---|---|---|
| Job scan + eligibility + sponsorship | 0 model calls (APIs, regexes, registers); Haiku on ~40 ambiguous postings/day | Haiku | 40 × 3K in | 0.40 |
| 8 AM ranking of the batch | 1 call/day, ~25K in (60 jobs × 350 tokens + fact store, cached) / 3K out | Fable 5.1 | 25K/3K | 7.50 (cache brings the input part down: ~5.00) |
| Applications, 20/day × 15 steps | 300 steps/day; 0.85 cache hit; ~6K in / 300 out per step | Sonnet 5.5 | — | 300 × $0.012 × 25 = **90** |
| same on Haiku 5.5 (plain Greenhouse/Lever/Ashby forms) | | Haiku | | 300 × $0.0012 × 25 = **9** |
| Cover letters, 20/day | 1.3 calls × 3K in / 500 out | Sonnet | | 20 × $0.012 × 25 = 6 |
| Answer-bank matches, ~30/day | Haiku, 1.5K in / 50 out | Haiku | | 0.15 |
| Brain review of failed/odd runs, ~4/day | Fable, 8K in (trace summary) / 1K out | Fable 5.1 | | 4 × $0.13 × 25 = 13 |
| Needs-You triage + his questions in chat | Fable, ~10/day × 4K/600 | Fable 5.1 | | 10 × $0.07 × 25 = 17 |
| Email triage, 60/day | Haiku, 1.2K in / 60 out each | Haiku | | 60 × $0.00015 × 30 = 0.30 |
| Email date/action extraction, ~15/day | Haiku | | | 0.10 |
| Email reply drafts, ~5/day | Sonnet, 3K/400 | Sonnet | | 5 × $0.01 × 30 = 1.50 |
| School: course-site reads, 6 runs/day × 6 steps | Haiku (reading, no forms) | Haiku | | 36 × $0.0012 × 30 = 1.30 |
| School: ranking Do now/next, 1/day | Fable, 6K/800 | Fable | | 30 × $0.10 = 3 |
| Chat as today | mixed | | | 3–5 |

## Three budgets to choose from

| Plan | Brain | Browser worker | Est. $/month | What you give up |
|---|---|---|---|---|
| **Lean** | Fable 5.1 for the 8 AM batch and Needs-You triage only (reviews on Sonnet) | Haiku 5.5, Sonnet only on retry | **≈ $35** | some applications take a second run; brain reviews less |
| **Standard (recommended)** | Fable 5.1 for batch, reviews, triage, chat | Sonnet 5.5 | **≈ $140** | — |
| **Full** | Fable 5.1 everywhere a worker fails, higher effort | Sonnet 5.5, Opus 5.5 on retry | ≈ $200+ | nothing; pays for marginal reliability |

The old $10/month budget covers none of these at 20 applications a day; at **5 applications a day** Lean is about $12 and Standard about $40.

With the OpenAI key instead (Terra for the brain, Luna for workers): Lean ≈ $20, Standard ≈ $90 (Terra is a weaker brain than Fable; ranking and reviews suffer first).

## The spend cap

Code, not advice: `core/llm/budget.ts` reads the usage log (dollars per model per day, already recorded) and refuses model calls when today's or this month's total reaches the cap set in Settings (daily default $6, monthly default $140 on Standard). When the cap trips, every worker stops at a safe point (never mid-submit), the brain is not called, and the Powerhouse shows "Paused: spend cap" with the numbers; a Chrome notification tells him. The Jobs page's per-run limit ($0.60) stays.

## The chosen plan: $25 a month (decided 2026-11-10)

| Line | Model | $/month |
|---|---|---|
| Applications, 15/day × ~15 steps | Haiku 5.5 (Sonnet 5.5 only on a retry) | 6.75 |
| Cover letters, 15/day | Sonnet 5.5 | 4.50 |
| 8 AM batch ranking, 1/day | Sonnet 5.5 (Fable 5.1 only when he asks a hard question in chat; off by default) | 2.00 |
| Reviews of failed runs, Needs-You triage | Sonnet 5.5 | 1.50 |
| Email triage + extraction (Gmail, with school mail forwarded) | Haiku 5.5 | 0.50 |
| Email reply drafts, ~5/day | Sonnet 5.5 | 1.50 |
| School reads (Haiku) + daily ranking (Sonnet) | | 1.60 |
| Chat as today | mixed | 3.00 |
| Answer-bank matching, eligibility edge cases | Haiku 5.5 | 0.50 |
| **Total** | | **≈ $22** |

Caps: daily $1.00, monthly $25.00 (Settings → Spend). At 20 applications a day the total is ≈ $26; the batch size defaults to 15. The brain is Sonnet 5.5 at this budget; `models.ts` keeps `brain: "claude-sonnet-5-5"` and `brainDeep: "claude-fable-5-1"` for the few calls he asks for explicitly.

## What to decide at the checkpoint

1. Which plan (Lean / Standard / Full), or a number.
2. Anthropic key for the brain (Fable 5.1 needs one) or stay on OpenAI only.
3. Applications per day (20 is the brief; 10 halves the biggest line).
