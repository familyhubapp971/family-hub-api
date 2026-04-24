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
- Squash-merge unless the feature spans multiple meaningful commits.
- Use the [PR template](.github/pull_request_template.md) — it enforces
  the Jira link, Gherkin acceptance check, test plan, and rollout notes.

### Branch & PR naming (Jira auto-link)

The Jira ↔ GitHub integration links commits, branches, and PRs to FHS
tickets when the ticket key appears in the name. Use:

- **Branch:** `<type>/FHS-XXX-short-slug` — e.g., `feat/FHS-149-stack-scaffolding`
- **PR title:** `<type>(FHS-XXX): short summary` — e.g.,
  `feat(FHS-149): scaffold Hono API with /health and /hello`
- **Commit footer:** include `Refs FHS-XXX` or `Closes FHS-XXX` to drive
  Jira workflow transitions (configured per-project).

Types follow Conventional Commits: `feat`, `fix`, `chore`, `docs`, `test`,
`refactor`, `perf`.

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
  product/      # what & why — owned by product-manager agent
    overview.md
    personas.md
    features/
      <feature-slug>.md
  technical/    # how — owned by engineering (architect-reviewer, backend-developer, etc.)
    architecture.md
    api/
    data-model/
    deployment.md
    decisions/  # ADRs (mirrors docs/decisions/ if used)
```

- `docs/product/` holds user-facing requirements: personas, user stories,
  acceptance criteria, success metrics, scope boundaries.
- `docs/technical/` holds implementation specs derived from those
  requirements: API contracts, schemas, sequence diagrams, infra topology.
- Every product requirement should have a corresponding technical doc once
  implementation begins. Cross-link both directions.

### User story format (required)

Every requirement in `docs/product/features/` must be expressed as one or
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
2. Agent drafts `docs/product/features/<slug>.md` using the template above.
3. User reviews and approves the requirement doc.
4. Engineering subagents (`backend-developer`, `frontend-developer`,
   `api-designer`, etc.) translate it into `docs/technical/...` specs.
5. Implementation references the Gherkin scenarios as the source of truth
   for both unit tests (Vitest) and E2E tests (Playwright). Test names
   should mirror scenario names so traceability is automatic.

---

## Useful slash commands

- `/plan`, `/write-plan`, `/execute-plan` — planning lifecycle
- `/brainstorm` — feature exploration
- `/start` — surface relevant skills at session start
- `/status` — check progress
