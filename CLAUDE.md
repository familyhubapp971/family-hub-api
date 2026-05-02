# Family Hub — Claude Code Instructions

This file is automatically loaded by Claude Code in this repo. It augments
the global config at `~/.claude/CLAUDE.md`, which exposes the full local
skill catalogue (Anthropic skills, SWE Superpowers, Plugins Plus, subagents,
slash commands, prompt-generator tool).

**All skills, agents, and slash commands installed at `~/.claude/` are
active in this project.** Do not duplicate global definitions here — only
record project-specific context, conventions, and skill-routing rules below.

---

## Project context

**Family Hub** is a multi-tenant SaaS platform for families to coordinate
schedules, tasks, and shared life. See [README.md](README.md) for the public
overview.

**Stack:** Hono + Drizzle + Zod (API) · React + Vite + Tailwind (web) ·
Postgres with RLS (data) · Vitest + Playwright + k6 (testing) · Railway
(hosting) · Supabase (auth + email).

**Repo layout (planned):**

```text
apps/api    apps/web
packages/shared  packages/test-utils
documents/{features,technical,decisions,strategy}
```

**Branches:** `main` (production) · `staging` (pre-prod) · feature → PR into
`staging` → promoted to `main`. Both protected: 1 approval, conversation
resolution required, no force pushes.

**Jira project:** FHS (`https://qualicion2.atlassian.net/browse/FHS-...`).
Reference the ticket key in commit messages and PR titles.

---

## Skill routing — when to use what

These are project-specific cues for when to invoke skills/agents. They do
**not** override the trigger conditions in each skill's own definition.

### Always

- **`using-superpowers`** — at the start of any conversation, surface
  relevant skills.
- **`verification-before-completion`** — never claim work is "done" without
  running the verification commands and confirming output.
- **`systematic-debugging`** — for any bug, test failure, or unexpected
  behavior, before proposing fixes.

### Planning & execution

- **`brainstorming`** — before any new feature, component, or behavior change.
- **`writing-plans`** / **`/write-plan`** — for multi-step tasks with
  specifications.
- **`executing-plans`** / **`/execute-plan`** — when working through a written plan.
- **`subagent-driven-development`** / **`dispatching-parallel-agents`** — when
  the plan has independent tasks that can be parallelized.
- **`planning-with-files`** — for research-heavy or >5-tool-call tasks.

### Implementation

- **`test-driven-development`** — for any feature or bugfix, before writing
  implementation code. The repo uses Vitest (unit) and Playwright (E2E).
- **`using-git-worktrees`** — for feature work that needs isolation.
- **`finishing-a-development-branch`** — when work is complete and ready
  to integrate.

### Code review

- **`requesting-code-review`** — before merging.
- **`receiving-code-review`** — when processing PR feedback.

### Stack-specific (Plugins Plus)

- **API work** → `15-api-development`, `06-backend-dev`
- **React/Vite/Tailwind** → `05-frontend-dev`
- **Postgres / Drizzle** → `11-data-pipelines` (for ETL/migrations),
  `12-data-analytics` (for read patterns)
- **Auth / RLS** → `03-security-fundamentals`, `04-security-advanced`
- **Railway / CI / Docker** → `01-devops-basics`, `02-devops-advanced`
- **Vitest / Playwright / k6** → `09-test-automation`, `10-performance-testing`
- **Supabase / Jira / GitHub APIs** → `16-api-integration`

### Frontend / design artifacts

- **`frontend-design`** — production-grade UI work.
- **`shadcn-ui`** — when integrating shadcn components.
- **`webapp-testing`** — interactive Playwright debugging of the local web app.

---

## Subagents

Reference `~/.claude/agents/` for the 135 specialised agents. Most useful
for this project:

- `01-core-development/{api-designer,backend-developer,frontend-developer,fullstack-developer,react-specialist}`
- `02-language-specialists/{typescript-pro,python-pro}`
- `03-infrastructure/{deployment-engineer,docker-expert,terraform-engineer,devops-engineer}`
- `04-quality-security/{code-reviewer,test-automator,security-auditor,security-engineer,qa-expert}`
- `06-developer-experience/{documentation-engineer,dx-optimizer,build-engineer}`
- `08-business-product/product-manager`
- `09-meta-orchestration/{multi-agent-coordinator,context-manager}`

Delegate via the Task tool when a subagent's specialty matches the work.

---

## Repo conventions

### Commits

- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `perf:`.
- Reference the Jira key in the body or footer (e.g., `FHS-149`).
- Local repo identity is `toonday-fh <familyhubapp971@gmail.com>` — do not
  alter unless explicitly asked.

**Keep messages short and plain.** One-line subject under 70 chars. Body
is optional — add only when the _why_ isn't obvious from the diff or the
ticket. When a body is needed, max ~5 lines, plain language, no marketing
voice. Don't recap the diff (the diff already shows it). Don't list every
sub-decision and every nit you fixed — those live in the PR body or the
Jira ticket. **Goal: a future reader scanning `git log --oneline` learns
what changed; clicking through tells them why.**

Anti-pattern: 30-line commit messages with bulleted "What ships",
self-review notes, and follow-up trackers. That belongs in the PR body
or Jira comment, not the commit.

### Pull requests

- Target `staging` (not `main`) for feature work.
- **Merge style (conditional, per [ADR 0006](documents/decisions/0006-branching-strategy.md)):**
  - **Solo / 1 active contributor (current):** squash-merge feature → staging; merge-commit `staging → main`.
  - **≥2 active contributors:** switch to `--no-ff` merge commits at every level. Trigger: second person opens their first PR.
- Use the [PR template](.github/pull_request_template.md) — it enforces
  the Jira link, Gherkin acceptance check, and rollout notes.
- **Self-review every PR before opening it.** Run the `code-reviewer`
  subagent ([`.claude/agents/code-reviewer.md`](.claude/agents/code-reviewer.md))
  on the branch's diff with the ticket context; action every blocking
  finding in the same branch; mention the review in the PR body
  (e.g., _"Self-reviewed via code-reviewer subagent; findings addressed
  in commit abc1234"_). Defer non-blocking findings to a "Follow-ups"
  section so the human reviewer can see what was punted on purpose.
  See the [`requesting-code-review`](.claude/skills/requesting-code-review/SKILL.md)
  skill for the workflow.

**Keep PR bodies short.** Default sections are: **Summary** (1-3 lines),
**AC trace** (one line per AC, pass/fail), and **Self-review** (one
sentence + count of blockers actioned). Add anything else only when it
genuinely changes how a reviewer evaluates the PR.

**Do NOT include a "Test plan" section.** Verification commands ran
locally and CI status are not artefacts the reviewer needs to read —
CI either passes (visible on the PR) or it doesn't. If a manual
verification step is essential to assess the change (e.g. a UI flow a
reviewer should click through), put it in a one-line note under
Summary. Otherwise skip it.

**Don't bloat with**: "What ships" exhaustive bullets duplicating the
diff, "Decisions worth flagging" boilerplate, "Deferred follow-ups"
when there are none, marketing-voice section headings. The diff and
the ticket already say most of this.

> **Bootstrap-phase policy (effective 2026-04-24):** all merges land on
> `staging` only. **Do not open or merge `staging` → `main` promotion
> PRs.** `main` is held at its current commit until the W1 vertical
> slice (FHS-179 epic) is complete and validated, after which everything
> promotes to `main` as one tested batch. Revisit when FHS-198 ships.

### Branch & PR naming (Jira auto-link)

**Rule:** Every Jira ticket gets its own feature branch. **Never commit
directly to `staging` or `main`** — always branch first, even for
single-file changes.

The Jira ↔ GitHub integration links commits, branches, and PRs to FHS
tickets when the ticket key appears in the name. Use:

- **Branch:** `<type>/FHS-XXX-short-slug` — short and identifiable, 2–4
  kebab-case words. Examples:
  - `feat/FHS-149-stack-scaffold`
  - `fix/FHS-12-tenant-ctx-async`
  - `documents/FHS-146-claude-md-rules`
- **PR title:** `<type>(FHS-XXX): short summary` — e.g.,
  `feat(FHS-149): scaffold Hono API with /health and /hello`
- **PR target:** `staging` (not `main`) for feature work.
- **Commit footer:** include `Refs FHS-XXX` or `Closes FHS-XXX` to drive
  Jira workflow transitions (configured per-project).

Types follow Conventional Commits: `feat`, `fix`, `chore`, `docs`, `test`,
`refactor`, `perf`.

**First action when starting a ticket:**

```bash
git checkout staging && git pull   # branch from staging during bootstrap
git checkout -b <type>/FHS-XXX-short-slug
git push -u origin <type>/FHS-XXX-short-slug   # publish so the Jira rule fires
```

(Branch from `main` once the staging-only policy is lifted.)

> **Trigger rule:** creating and **pushing** the feature branch is the
> signal that work has started. The Jira Automation rule **"Branch
> created → In Progress"** (configured in
> `https://qualicion2.atlassian.net/jira/software/projects/FHS/settings/automation`)
> auto-transitions the matching FHS-XXX ticket from To Do → In Progress
> when the branch is pushed. No manual API call needed.
>
> **Manual fallback** — if the automation rule is disabled or fails,
> transition manually:
>
> ```bash
> curl -s -u "$EMAIL:$JIRA_API_TOKEN" -X POST \
>   "$URL/rest/api/3/issue/FHS-XXX/transitions" \
>   -H "Content-Type: application/json" \
>   -d '{"transition":{"id":"21"}}'   # 21 = In Progress for FHS
> ```

### Closing tickets (post-merge)

**Rule:** As soon as the implementation PR for a ticket merges into the
target branch (`staging` during the bootstrap phase; `main` afterwards),
the ticket must be commented and closed — automatically, without the
user asking.

Steps:

1. Verify the merge landed on `main` (and `staging` is in sync if a
   promotion PR was used).
2. Post a **brief, structured** comment on the Jira ticket using ADF
   `bulletList` / `heading` blocks. Never dense prose. 4–8 bullets is
   the target — cover what was delivered, the PR number(s), any
   caveats / follow-ups, and the next ticket if known.
3. Transition the ticket to **Done** (transition ID `31` for FHS;
   confirm via `GET /rest/api/3/issue/<KEY>/transitions` if unsure).
4. If the work has caveats / partial completion, still close, but list
   the caveats under a "Caveats" or "Follow-ups" section in the comment.

The closing comment is part of the deliverable, not a separate task.
Drift between merged code and ticket status is a process bug.

After the transition, **refresh the Confluence "FHS — Epics & Tickets"
page** (ID `3079340034` in space `FA`) so its Progress column stays
in sync with Jira:

```bash
set -a; source .env.local; set +a
python3 scripts/refresh-confluence-epics-page.py --reason "FHS-XXX close"
```

The script ([`scripts/refresh-confluence-epics-page.py`](scripts/refresh-confluence-epics-page.py))
fetches every epic + its children from Jira, groups by Fix Version,
renders a storage-format body with status lozenges and per-epic
progress (done/total), and PUTs version+1 to the page. Standard
library only.

If multiple tickets close in quick succession (child close that
cascades to an epic close), refresh **once at the end**, not per
transition.

### Epic status follows its children

An epic's status always mirrors the state of its children:

- **First child enters In Progress** → transition the epic from
  **To Do → In Progress** (transition id `21` for FHS).
- **All children Done** (treat "Won't Do" / "Cancelled" as Done) →
  transition the epic to **Done** (id `31`) with a brief structured
  comment listing each child story it delivered. Don't make the user
  chase epic closure — same logic as the post-merge ticket close,
  one level up.
- If an epic is already at the target status, skip — don't re-transition.

After any epic transition, **refresh the Confluence "FHS — Epics &
Tickets" page** per the Confluence-refresh step in the "Closing
tickets" section above.

### Fix Versions — Sprint cluster releases

The FHS project uses **Fix Versions** to mark Sprint cluster releases,
mapped 1-to-1 to the Sprint-to-milestone table in
[`documents/strategy/saas-transformation.md`](documents/strategy/saas-transformation.md):

| Version                  | Sprint cluster                 |
| ------------------------ | ------------------------------ |
| `0.0-bootstrap`          | Sprint 0 — Bootstrap (current) |
| `0.1-tenant-foundation`  | Sprint 1                       |
| `0.2-signup-custom-url`  | Sprint 2                       |
| `0.3-modules-gating`     | Sprint 3                       |
| `0.4-stripe-billing`     | Sprint 4                       |
| `0.5-invites-roles`      | Sprint 5                       |
| `1.0-white-label-launch` | Sprint 6 (GA)                  |

Rules:

- **Tag at branch-creation time** (alongside the auto-In-Progress
  transition) so Sprint-cluster ownership is visible from day 1.
- **Mark a Fix Version released** when the Sprint cluster's vertical
  slice ships and is verified in production. For `0.0-bootstrap`, that's
  when [FHS-198](https://qualicion2.atlassian.net/browse/FHS-198) closes
  and the staging → main batch promotion lands per
  [FHS-200](https://qualicion2.atlassian.net/browse/FHS-200).
- **Auto-generate release notes** per version when it ships:
  `project = FHS AND fixVersion = "<version>"` lists every ticket;
  publish to a per-version Confluence page.
- Post-launch we move to semver `1.0.x` / `1.1.x`.

### Decisions log sync

ADRs in [`documents/decisions/`](documents/decisions/) are the canonical record of
project shape. **When an ADR is added, superseded, or materially edited,
propagate the change across every surface that references it** in the
same PR (per bundling) or the same session (for Jira / Confluence):

| Surface                                                                                  | What to update                                                                      |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `documents/decisions/<NNNN>-<slug>.md`                                                   | The ADR file itself                                                                 |
| `documents/decisions/README.md`                                                          | Index entry — accepted / superseded marker                                          |
| Root [`README.md`](README.md)                                                            | ADR list entry (if present)                                                         |
| [`documents/strategy/saas-transformation.md`](documents/strategy/saas-transformation.md) | Architecture table row pointing at the ADR                                          |
| `CLAUDE.md`                                                                              | Any conventions section that references the ADR                                     |
| Jira: epic comment                                                                       | Structured comment summarising the ADR + linking to repo                            |
| Jira: child tickets                                                                      | Comment on any open ticket whose scope shifts (header: "Scope adjusted — ADR XXXX") |
| Confluence: "Family Hub — Vision & Strategy" → "Architecture & multi-tenancy"            | Update architecture table row                                                       |
| Confluence: "FHS — Epics & Tickets"                                                      | Refresh via builder (per the Confluence-refresh rule)                               |

Cross-link both ways: the ADR file links to the Jira ticket(s) it
answers; those tickets link back to the ADR. Never delete a superseded
ADR — flip its `Status:` line to `superseded by NNNN`. After any
update, re-read at least the strategy doc + Architecture Confluence
page to confirm they don't still reference the dead decision.

### Feature impact analysis (pre-implementation)

Before writing implementation code for **any** feature, ticket, or
behaviour change, produce a short impact analysis covering at minimum
**frontend**, **backend**, and **infrastructure**. Surface it to the
user and wait for acknowledgement before starting the work — this
catches cross-cutting dependencies (a new column needs a migration +
API schema + form field + RLS policy + seed update) before they turn
into mid-PR rework.

Where it goes:

- For ticketed work, post the analysis as a comment on the Jira
  ticket (structured ADF: bullets/headings, never prose). For ad-hoc
  tasks, post it inline in the conversation.
- If the work warrants a `documents/features/<slug>.md` doc, add an
  **Impact analysis** section to that doc as well.

Dimensions to scan (skip a row only if you can articulate why it's
genuinely untouched — silence is not the same as "no impact"):

| Layer                    | Examples of what to check                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Frontend (web)**       | Routes, components, hooks, forms, validation schemas, copy, design-system tokens, accessibility, mobile-web fallback    |
| **Backend (api)**        | New/changed endpoints, Zod schemas, OpenAPI spec, middleware, jobs, error envelope, rate limits, idempotency            |
| **Data layer**           | Drizzle schema, migrations (and rollback), RLS policies, indexes, seed data, fixtures, FKs to `tenant_id` / `users`     |
| **Infrastructure**       | Railway services, env vars, Supabase config (auth + storage), Stripe products/webhooks, CI workflows, scheduled jobs    |
| **Auth / multi-tenancy** | New role checks, RLS coverage on new tables, `tenant_id` propagation, JWKS / JWT claim assumptions                      |
| **Cross-cutting**        | Shared package types (`packages/shared`), test utilities (`packages/test-utils`), feature flags, observability surfaces |
| **Tests**                | Which tier (unit / integration / e2e / perf) gains scenarios; new fixtures; whether tenant-isolation scenario is needed |
| **Docs / process**       | `documents/features/`, `documents/technical/`, ADRs (does this need a new one?), CLAUDE.md, README, OpenAPI clients     |

Recommended template for the analysis comment:

```markdown
**Impact analysis — FHS-XXX**

- **Frontend:** <bullets, or "no impact — server-only">
- **Backend:** <bullets, or "no impact">
- **Data:** <migration? new table? RLS?>
- **Infra:** <env vars, services, CI?>
- **Tests:** <which tier(s); tenant-isolation scenario yes/no>
- **Docs/ADR:** <files to update; ADR needed yes/no>
- **Risks / unknowns:** <open questions to resolve before coding>
```

**Anti-pattern:** "I'll figure out the FE/infra parts as I go." That's
how a backend ticket grows a surprise migration on day 3 and a copy
change on day 4. Cheap to think about up front; expensive to discover
mid-implementation.

The analysis is not a separate Jira ticket — it's a comment on the
implementing ticket. Once acknowledged, it becomes the scope contract
for the PR.

### Change-impact propagation

When a change has impact beyond its immediate surface, **flag it
explicitly before doing the work**, wait for acknowledgement, then
update every affected surface in the same PR (per the bundling rule).
Categories to scan when proposing a change:

| Category               | Surfaces                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Product / requirements | `documents/features/`, Jira ticket scope + AC, PR template                                          |
| Technical              | code, schemas, API contracts (OpenAPI), migrations, infra (Railway, Supabase, Stripe), CI workflows |
| Tests                  | Vitest unit, Vitest integration, Playwright E2E, k6 perf                                            |
| Architecture           | ADRs in `documents/decisions/` — write a new ADR or supersede an existing one                       |
| Strategy               | `documents/strategy/saas-transformation.md` and any Confluence mirror                               |
| Business / launch      | pricing, marketing copy, sales collateral, onboarding flow copy                                     |
| Confluence             | `https://qualicion2.atlassian.net/spaces/FA/...` pages                                              |
| Legal / compliance     | LICENSE, ToS, privacy policy, regulated-tier obligations                                            |
| Process                | CLAUDE.md rules, PR template, memory entries                                                        |

**Anti-pattern:** silently updating only the file the user pointed at,
leaving every other affected surface stale. That's how a "small"
change becomes a months-later bug or contradiction.

When in doubt, flag it. The cost of "this change touches X / Y / Z,
OK?" is trivial; the cost of letting drift compound is large. Close
the loop in the Jira ticket's closing comment by listing the surfaces
touched so the audit trail captures the cascade.

### Code style

- TypeScript strict mode everywhere.
- 2-space indent, LF line endings, UTF-8 (enforced by `.editorconfig`).
- No comments unless the _why_ is non-obvious.
- Avoid premature abstraction — three similar lines beats a wrong helper.

### Secrets

- All secrets live in `.env.local` (gitignored) or Railway/Supabase env vars.
- Never commit tokens, API keys, or `.env*` files. GitHub secret scanning +
  push protection are enabled on the repo as a backstop.

### Multi-tenancy

- Every table that holds tenant data carries `tenant_id`.
- Postgres RLS policies enforce isolation — never bypass with `bypassrls`.
- Tenant context is set per-request in API middleware (FHS-12).

### Responsive design (mobile / tablet / desktop)

Every page and component **must** look and work correctly across **three
viewports**:

- **Mobile** (≤ 640px / Tailwind default): single-column stacks,
  finger-sized tap targets (≥ 44×44px), no horizontal scroll on the
  main flow, fonts cap at `text-base` for body / `text-3xl` for hero.
- **Tablet** (`sm:` 640px and `md:` 768px): two-column layouts where
  density allows; nav can stay horizontal but trim labels if needed.
- **Desktop** (`lg:` 1024px and `xl:` 1280px+): full multi-column
  layouts, the design's intended max widths (`max-w-7xl` for
  marketing, `max-w-[1400px]` for authenticated dashboards), hover
  affordances enabled.

How to apply:

- Default styles target **mobile** first; layer `sm:` / `md:` / `lg:` /
  `xl:` breakpoints to scale up. Never the other way around.
- Use the design system's **`xs: 375px`** breakpoint (preset extension)
  for the smallest devices when extra-tight rules are needed.
- Hover effects (`hover:-translate-y-1`, `hover:shadow-neo-lg`,
  `hover:scale-…`) must be wrapped in `motion-safe:` so
  `prefers-reduced-motion` users see colour changes only — and pointer-
  device-only via `@media (hover: hover)` if the effect is jarring on
  touch devices.
- Test in dev across at least three breakpoints before opening a PR:
  open Chrome DevTools → device toolbar → toggle iPhone, iPad, Desktop.
- Include a **"verified across breakpoints"** line in PR self-review
  notes for any UI ticket.

The "make it look good on Sarah's MacBook" reflex is fine for first
draft; the responsive sweep is **not optional** before merge — Family
Hub's adult users are 70%+ on phones in the field (per persona doc).

---

## Local-only conventions

These mirror the global rules in `~/.claude/CLAUDE.md` but are repeated
here for emphasis on this repo:

- **Never** update `git config` (local or global) without asking.
- **Never** run destructive git commands (`reset --hard`, `push --force`,
  `branch -D`, `clean -f`) without explicit user authorization.
- **Never** skip hooks (`--no-verify`, `--no-gpg-sign`) without explicit ask.
- **Never** create planning, decision, or analysis docs unless asked —
  ADRs in `documents/decisions/` are the exception (created via FHS-171/172/174).

---

## Explaining decisions — keep it simple

When explaining a decision, trade-off, or recommendation:

- **Lead with the answer** in one sentence. The reasoning comes after, only
  if asked or if it changes the user's choice.
- **Pick the shortest format that fits.** A one-line answer beats a
  three-paragraph one. A two-row table beats a five-row one. Bullets
  beat prose when there are 3+ parallel items, but don't bullet a
  single thought.
- **No hedging stacks.** "It depends, but generally, in most cases,
  arguably..." → just say which way you'd go and why. One sentence on
  the main trade-off is enough.
- **Skip the optionality theatre.** Don't list 3 options when 1 is
  obviously right and 2 are filler. Recommend the one and mention an
  alternative only if it's a real choice.
- **Drop ceremony.** No "Great question!", no "Let me walk you through
  this", no "TL;DR" headers on a 4-line answer.
- **Plain language over jargon** unless the jargon is the precise term.
  "Use a shared password manager so teammates don't DM you keys" beats
  "Implement centralized credential management with team-shared vault
  primitives for secret rotation hygiene."

If a decision genuinely needs more depth (architectural, multi-surface,
risk-bearing), **flag that it needs depth** and write the full version.
Most decisions don't.

---

## Requirements documentation

Use the **`product-manager`** subagent
(`~/.claude/agents/08-business-product/product-manager`) to capture and
maintain all app requirements. Whenever a new feature is discussed,
clarified, or scoped, the product-manager agent is responsible for writing
or updating the requirement docs **before** implementation begins.

### Folder layout

```text
documents/
  README.md         # index of subfolders + how docs flow
  features/         # what & why — owned by product-manager agent
    <feature-slug>.md
  technical/        # how — owned by engineering subagents
    architecture.md
    deployment.md
    slos.md
    api/
    data-model/
  decisions/        # ADRs — durable choices, immutable once accepted
    NNNN-kebab-case.md
  strategy/         # long-form strategy docs (vision, positioning, transformation)
    <topic-slug>.md
```

- `documents/features/` — user-facing requirements: personas, user stories,
  acceptance criteria, success metrics, scope boundaries.
- `documents/technical/` — implementation specs derived from features:
  API contracts, schemas, sequence diagrams, infra topology, SLOs.
- `documents/decisions/` — ADRs in MADR-lite format; see the
  [ADR section](#architecture-decision-records-adrs) below.
- `documents/strategy/` — long-form direction-setting docs that inform
  the features backlog.
- Every feature should have a corresponding technical doc once
  implementation begins. Cross-link both directions.

Each subfolder has its own `README.md` documenting purpose, when to add a
doc, and naming convention — read those before adding to the folder.

### User story format (required)

Every requirement in `documents/features/` must be expressed as one or
more **user stories** with **Gherkin (Given/When/Then)** acceptance
criteria. Template:

```markdown
# Feature: <name>

**Jira:** FHS-XXX
**Status:** draft | approved | in-progress | shipped
**Owner:** <product-manager handle>

## User stories

### Story 1: <short title>

**As a** <persona>
**I want** <capability>
**so that** <benefit>

#### Acceptance criteria

**Scenario: <descriptive scenario name>**

- **Given** <initial context / preconditions>
- **And** <additional context, optional>
- **When** <action / event>
- **Then** <observable outcome>
- **And** <additional outcome, optional>

**Scenario: <edge case or alternative path>**

- **Given** ...
- **When** ...
- **Then** ...

## Out of scope

- ...

## Open questions

- ...

## Success metrics

- ...
```

### Workflow

1. New feature request → invoke `product-manager` subagent.
2. Agent drafts `documents/features/<slug>.md` using the template above.
3. User reviews and approves the requirement doc.
4. Engineering subagents (`backend-developer`, `frontend-developer`,
   `api-designer`, etc.) translate it into `documents/technical/...` specs.
5. Implementation references the Gherkin scenarios as the source of truth
   for both unit tests (Vitest) and E2E tests (Playwright). Test names
   should mirror scenario names so traceability is automatic.

---

## Testing

Four test tiers under one **centralized** `tests/` directory at the repo
root — never colocated next to source. Mirrors the legacy family-hub
layout, reorganised by package within each tier.

### Folder structure (canonical)

```text
tests/
  unit/
    api/{routes,middleware,lib}/      # mirrors apps/api/src/
    web/{components,hooks}/           # mirrors apps/web/src/
    shared/{schemas}/                 # mirrors packages/shared/src/
  integration/
    vitest.config.ts                  # separate config from unit
    specs/                            # one spec per domain
    support/                          # global-setup, helpers, db client
    features/                         # Cucumber-style .feature files
  e2e/
    playwright.config.ts              # full matrix
    playwright.critical.config.ts     # @critical subset for PR CI
    features/                         # mirror documents/features/<slug>.md scenario names
    steps/                            # one file per feature slug
    support/pages/                    # page objects (no raw locators in steps)
  performance/
    config.js                         # BASE_URL + thresholds tied to documents/technical/slos.md
    scripts/                          # shared k6 helpers
    scenarios/{smoke,load,stress,soak}.js
    reports/                          # gitignored
```

Per-package `vitest.config.ts` files (`apps/api`, `apps/web`,
`packages/shared`) keep working — their `include` glob points at
`../../tests/unit/<pkg>/`.

> **Current state (2026-04-25):** test files added in FHS-150 / FHS-151
> are temporarily colocated. Migration into `tests/unit/<pkg>/` is
> tracked as part of [FHS-186](https://qualicion2.atlassian.net/browse/FHS-186)
> ("one green test per tier") so it lands together with the integration /
> e2e / perf hello-world scaffolds. **All new test files from this point
> on must be created under `tests/<tier>/...`, not colocated.**

### Unit — Vitest

- **Where:** `tests/unit/{api,web,shared}/...` mirroring source hierarchy.
- **File naming:** `*.test.ts` / `*.test.tsx` (reserve `*.spec.ts` for integration).
- **Run:** `pnpm test` (root, via `vitest.workspace.ts` — runs all packages); `pnpm test:watch`; `pnpm test:coverage` for merged lcov.
- **Environment:** `node` for api + shared; `jsdom` + `@testing-library/react` for web.
- **Coverage thresholds (starting):** lines 70%, branches 60%, functions 70% — raise to 80/70/80 after FHS-186 baseline. Hard-gating only after thresholds calibrate.
- **Scope:** pure functions, single class/module, no I/O. Mock external collaborators, **never** mock the thing under test.

### Integration — Vitest + Cucumber + real Postgres

- **Where:** `tests/integration/features/*.feature` (Gherkin scenarios) bound by `tests/integration/steps/*.steps.ts` (Vitest step definitions). Powered by [`@amiceli/vitest-cucumber`](https://github.com/amiceli/vitest-cucumber) — same BDD style as the E2E tier (FHS-218).
- **Config:** dedicated `tests/integration/vitest.config.ts` includes both `steps/**/*.steps.ts` (current) and `specs/**/*.spec.ts` (legacy, drained as scenarios migrate).
- **Run:** `pnpm test:integration` — spins Postgres 16 via `docker-compose.test.yml` on port 5433 (offset from dev's 5432). CI uses GitHub Actions `services:` block.
- **Setup:** drop + recreate test DB, `drizzle-kit push --force` to apply schema + RLS policies. Each scenario starts from a clean state via `Background:` in the .feature file (typically `TRUNCATE` or per-scenario seed).
- **Mandatory pattern:** every feature touching a tenant-scoped endpoint includes a `tenant isolation` scenario — tenant B reads return zero rows from tenant A. Defence in depth for [ADR 0001](documents/decisions/0001-multi-tenancy.md).
- **Cover the edges, not just the happy path:** boundary timestamps, oversized payloads, malformed Authorization headers, concurrent fan-out, unique-constraint races. The unit tier covers shape; integration covers what real Postgres + real network do.
- **Pool:** test pool is `max: 2`, `idle_timeout: 5`, separate from the prod pool. Lives in `tests/integration/support/db.ts` against `DATABASE_URL_TEST`.
- **Never mock the database** — mocked DBs hide RLS regressions and migration breakage.
- **`.feature` ↔ `.steps.ts` pairing convention:** one feature file ↔ one steps file, same slug. Step definitions are `Given`/`When`/`Then`/`And` callbacks inside `describeFeature(...)` blocks. `Background` runs before every scenario in that feature.

### E2E — Playwright + playwright-bdd

- **Where:** `tests/e2e/`. Two configs: `playwright.config.ts` (full matrix) and `playwright.critical.config.ts` (`@critical`-tagged subset, chromium only).
- **Traceability contract:** scenario names in `tests/e2e/features/<slug>.feature` are **character-for-character identical** to the Gherkin scenarios in `documents/features/<slug>.md`. `bddgen` generates the spec; the generated `test()` name carries through. This is the Jira AC ↔ test traceability mechanism.
- **Page objects:** `tests/e2e/support/pages/<FeatureName>Page.ts`. No raw `page.locator()` in step files.
- **Browser matrix:** chromium only on PR (critical subset, fast); full matrix (chromium + webkit + mobile-chrome) post-merge to staging.
- **Run:** `pnpm test:e2e` (full), `pnpm test:e2e:critical` (PR-fast subset), `pnpm test:e2e:ui` (interactive). Each script runs `bddgen` first then `playwright test`.

### Performance — k6

- **Where:** `tests/performance/scenarios/{smoke,load,stress,soak}.js` with shared helpers in `tests/performance/scripts/`.
- **Multi-tenancy add-ons** vs family-hub: per-tenant VU groups (split VUs across 2–3 synthetic tenants to validate RLS overhead under concurrent load); `withTenantHeader(tenantSlug)` helper.
- **Thresholds:** defined in `tests/performance/config.js`, tied to `documents/technical/slos.md` (p95 < 250 ms read, p95 < 500 ms write — until SLO doc lands, those are the working targets).
- **Schedule:**
  - `smoke` — every CI run after integration (30s, 1 VU).
  - `load` — nightly against staging.
  - `stress` — pre-release, before staging → main promotion.
  - `soak` — weekly Sunday nightly run.
- **Run locally:** `pnpm perf:smoke`, `pnpm perf:load`, etc.

### Cross-tier rules

- **No mocking the DB in integration or E2E.** Real Postgres is mandatory.
- **Test names mirror Gherkin scenario names** for automatic AC traceability.
- **A feature is not "done"** until its tier-appropriate tests pass green in CI — the pre-merge checklist enforces this.
- **Shared test utilities live in `packages/test-utils`** (FHS-184) — `withTenant()`, factories, `testDb`, RTL render wrapper, MSW handlers, `makeRequest()`. Never duplicate these in test files.
- **Pipeline orchestration** (per the test-automator design):
  - **PR CI (must finish < 5 min, gates merge):** unit + integration + e2e-critical + typecheck (parallel jobs).
  - **Post-merge to staging:** e2e-full matrix + perf smoke.
  - **Nightly:** perf load (daily) + perf soak (weekly Sunday).
  - **Pre-release:** perf stress before staging → main batch promotion.

---

## API contracts (OpenAPI)

- The Hono API publishes its OpenAPI 3.1 spec at `apps/api/openapi.yaml`
  (generated from Zod schemas via `@hono/zod-openapi`).
- Every new endpoint must have a Zod schema for request + response and be
  registered with the OpenAPI app — no untyped routes.
- Run `pnpm -F api openapi:generate` after changing schemas; commit the
  resulting `openapi.yaml` so consumers (frontend, docs, mobile) get a
  reviewable diff.
- Breaking changes (removed fields, changed types, removed endpoints) bump
  the API version in the spec and trigger a "breaking" label on the PR.

This section will grow as the API matures — auth schemes, pagination
convention, error envelope, rate-limit headers, etc.

---

## Architecture Decision Records (ADRs)

ADRs live in `documents/decisions/`. One file per decision:
`NNNN-short-title.md` (zero-padded sequential numbering, kebab-case).

Write an ADR whenever you make a decision that:

- changes the shape of the system in a way someone might later question,
- chooses one viable option over another (e.g., Postgres vs DynamoDB),
- locks in a constraint future contributors need to respect.

Don't write an ADR for routine implementation choices — only for the
ones future-you would want context on.

Template (Nygard / MADR-lite):

```markdown
# NNNN — <decision title>

**Status:** proposed | accepted | superseded by NNNN
**Date:** YYYY-MM-DD
**Jira:** FHS-XXX (optional)

## Context

<What forces are at play? What problem are we solving?>

## Decision

<What did we decide?>

## Consequences

<What becomes easier? What becomes harder? What follow-ups does this create?>

## Alternatives considered

- **<option A>** — why rejected
- **<option B>** — why rejected
```

Initial seed ADRs are tracked in FHS-171, FHS-172, FHS-174.

---

## Pre-merge checklist

Every PR author confirms (the [PR template](.github/pull_request_template.md)
mirrors this list):

- [ ] **Jira:** ticket key in branch name + PR title + commit footer
- [ ] **Tests:** unit (Vitest) + E2E (Playwright) added/updated; `pnpm test` green
- [ ] **Acceptance criteria:** every Gherkin scenario from the ticket maps to a passing test
- [ ] **Types:** TypeScript strict, no new `any`, schemas validate at boundaries
- [ ] **Multi-tenancy:** queries respect `tenant_id` / RLS; no `bypassrls`
- [ ] **Secrets:** nothing in git that should be in `.env.local` or Railway env
- [ ] **OpenAPI:** spec regenerated and committed if API surface changed
- [ ] **Docs:** `documents/features/` or `documents/technical/` updated; ADR added in `documents/decisions/` if a decision was made
- [ ] **Migrations:** Drizzle migration committed; rollback path noted in PR body
- [ ] **Observability:** new failure modes have logs/metrics; alerts updated if SLO-relevant
- [ ] **Manual verification:** described in the PR body — what was actually exercised in a browser / curl

---

## Useful slash commands

- `/plan`, `/write-plan`, `/execute-plan` — planning lifecycle
- `/brainstorm` — feature exploration
- `/start` — surface relevant skills at session start
- `/status` — check progress

---

## Living document

This file is **expected to evolve**. When we encounter a recurring decision,
a footgun, or a convention worth codifying, add it here in the relevant
section. Drift between code reality and CLAUDE.md is a bug — fix in the
same PR that introduced the drift.
