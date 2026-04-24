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
docs/{features,technical,decisions,strategy}
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

### Pull requests

- Target `staging` (not `main`) for feature work.
- **Merge style (conditional, per [ADR 0006](docs/decisions/0006-branching-strategy.md)):**
  - **Solo / 1 active contributor (current):** squash-merge feature → staging; merge-commit `staging → main`.
  - **≥2 active contributors:** switch to `--no-ff` merge commits at every level. Trigger: second person opens their first PR.
- Use the [PR template](.github/pull_request_template.md) — it enforces
  the Jira link, Gherkin acceptance check, test plan, and rollout notes.
- **Self-review every PR before opening it.** Run the `code-reviewer`
  subagent ([`.claude/agents/code-reviewer.md`](.claude/agents/code-reviewer.md))
  on the branch's diff with the ticket context; action every blocking
  finding in the same branch; mention the review in the PR body
  (e.g., *"Self-reviewed via code-reviewer subagent; findings addressed
  in commit abc1234"*). Defer non-blocking findings to a "Follow-ups"
  section so the human reviewer can see what was punted on purpose.
  See the [`requesting-code-review`](.claude/skills/requesting-code-review/SKILL.md)
  skill for the workflow.

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
  - `docs/FHS-146-claude-md-rules`
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

### Closing parent epics

After closing a child story, check the parent epic. If **every** child
of that epic is also Done (treat "Won't Do" / "Cancelled" as Done for
this purpose), close the epic too with a brief structured comment
listing each child story it delivered. Don't make the user chase
parent-epic closure — same logic as the post-merge ticket close, one
level up.

### Change-impact propagation

When a change has impact beyond its immediate surface, **flag it
explicitly before doing the work**, wait for acknowledgement, then
update every affected surface in the same PR (per the bundling rule).
Categories to scan when proposing a change:

| Category | Surfaces |
| --- | --- |
| Product / requirements | `docs/features/`, Jira ticket scope + AC, PR template |
| Technical | code, schemas, API contracts (OpenAPI), migrations, infra (Railway, Supabase, Stripe), CI workflows |
| Tests | Vitest unit, Vitest integration, Playwright E2E, k6 perf |
| Architecture | ADRs in `docs/decisions/` — write a new ADR or supersede an existing one |
| Strategy | `docs/strategy/saas-transformation.md` and any Confluence mirror |
| Business / launch | pricing, marketing copy, sales collateral, onboarding flow copy |
| Confluence | `https://qualicion2.atlassian.net/spaces/FA/...` pages |
| Legal / compliance | LICENSE, ToS, privacy policy, regulated-tier obligations |
| Process | CLAUDE.md rules, PR template, memory entries |

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
- No comments unless the *why* is non-obvious.
- Avoid premature abstraction — three similar lines beats a wrong helper.

### Secrets

- All secrets live in `.env.local` (gitignored) or Railway/Supabase env vars.
- Never commit tokens, API keys, or `.env*` files. GitHub secret scanning +
  push protection are enabled on the repo as a backstop.

### Multi-tenancy

- Every table that holds tenant data carries `tenant_id`.
- Postgres RLS policies enforce isolation — never bypass with `bypassrls`.
- Tenant context is set per-request in API middleware (FHS-12).

---

## Local-only conventions

These mirror the global rules in `~/.claude/CLAUDE.md` but are repeated
here for emphasis on this repo:

- **Never** update `git config` (local or global) without asking.
- **Never** run destructive git commands (`reset --hard`, `push --force`,
  `branch -D`, `clean -f`) without explicit user authorization.
- **Never** skip hooks (`--no-verify`, `--no-gpg-sign`) without explicit ask.
- **Never** create planning, decision, or analysis docs unless asked —
  ADRs in `docs/decisions/` are the exception (created via FHS-171/172/174).

---

## Requirements documentation

Use the **`product-manager`** subagent
(`~/.claude/agents/08-business-product/product-manager`) to capture and
maintain all app requirements. Whenever a new feature is discussed,
clarified, or scoped, the product-manager agent is responsible for writing
or updating the requirement docs **before** implementation begins.

### Folder layout

```text
docs/
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

- `docs/features/` — user-facing requirements: personas, user stories,
  acceptance criteria, success metrics, scope boundaries.
- `docs/technical/` — implementation specs derived from features:
  API contracts, schemas, sequence diagrams, infra topology, SLOs.
- `docs/decisions/` — ADRs in MADR-lite format; see the
  [ADR section](#architecture-decision-records-adrs) below.
- `docs/strategy/` — long-form direction-setting docs that inform
  the features backlog.
- Every feature should have a corresponding technical doc once
  implementation begins. Cross-link both directions.

Each subfolder has its own `README.md` documenting purpose, when to add a
doc, and naming convention — read those before adding to the folder.

### User story format (required)

Every requirement in `docs/features/` must be expressed as one or
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
2. Agent drafts `docs/features/<slug>.md` using the template above.
3. User reviews and approves the requirement doc.
4. Engineering subagents (`backend-developer`, `frontend-developer`,
   `api-designer`, etc.) translate it into `docs/technical/...` specs.
5. Implementation references the Gherkin scenarios as the source of truth
   for both unit tests (Vitest) and E2E tests (Playwright). Test names
   should mirror scenario names so traceability is automatic.

---

## Testing

Four test tiers, each with a clear scope. Don't let one tier swallow
another's job.

### Unit — Vitest

- **Where:** colocated `*.test.ts` next to the source file (e.g.,
  `apps/api/src/users/users.service.test.ts`).
- **Scope:** pure functions, single class/module, no I/O. Mock external
  collaborators, but **never mock the thing under test**.
- **Run:** `pnpm test` (watches) · `pnpm test:run` (one-shot, used in CI).
- **Bar:** every public function in `packages/shared/` and every service
  method in `apps/api/src/**/*.service.ts` has direct unit coverage.

### Integration — Vitest + real Postgres

- **Where:** `apps/api/src/**/*.integration.test.ts`.
- **Scope:** API route → service → real Postgres (per-test transaction,
  rolled back at end). Exercises Drizzle queries and RLS policies for
  real. **Do not mock the database** — mocked DBs hide migration breakage.
- **Run:** `pnpm test:integration` (spins up local Postgres via
  docker-compose or uses the dev DB with a `_test` schema).
- **Bar:** every endpoint has an integration test for happy path + at
  least one tenant-isolation scenario (request as tenant A must not
  see tenant B's data).

### E2E — Playwright

- **Where:** `tests/e2e/**/*.spec.ts` at the repo root (or `apps/web/e2e/`
  if scoped to a single app).
- **Scope:** full browser → web → API → DB stack. One test per Gherkin
  scenario in the corresponding `docs/features/<slug>.md`. Test
  name **must** mirror scenario name for traceability.
- **Run:** `pnpm test:e2e` locally; runs against `staging` in CI on PRs
  targeting `main`.
- **Bar:** every user-facing acceptance criterion in a shipped feature
  has a passing Playwright scenario.

### Performance — k6

- **Where:** `tests/perf/**/*.js`.
- **Scope:** load + soak tests for performance-critical endpoints (auth,
  feed/timeline reads, write hot paths). Define SLOs in the script
  (e.g., p95 < 250 ms at 100 RPS for 5 min).
- **Run:** `pnpm test:perf` against staging; not in PR CI — run on
  release candidates and weekly.
- **Bar:** any endpoint added to the SLO list (in
  `docs/technical/slos.md`) has a k6 script that asserts its target.

### Cross-tier rules

- **No mocking the DB in integration or E2E.** Mocked DBs caused a prod
  migration failure historically — real Postgres is mandatory for those
  tiers.
- **Test names mirror Gherkin scenario names** so traceability between
  `docs/features/<slug>.md` and the test file is automatic.
- **A feature is not "done" until its tier-appropriate tests pass green
  in CI** — the pre-merge checklist enforces this.

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

ADRs live in `docs/decisions/`. One file per decision:
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
- [ ] **Docs:** `docs/features/` or `docs/technical/` updated; ADR added in `docs/decisions/` if a decision was made
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
