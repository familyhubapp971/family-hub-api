# Family Hub: Claude Code Instructions

This file is automatically loaded by Claude Code in this repo. It augments
the global config at `~/.claude/CLAUDE.md`, which exposes the full local
skill catalogue (Anthropic skills, SWE Superpowers, Plugins Plus, subagents,
slash commands, prompt-generator tool).

**All skills, agents, and slash commands installed at `~/.claude/` are
active in this project.** Do not duplicate global definitions here: only
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

## Talk to me in plain English (always)

The founder is **not an engineer**. Top rule in this file. Plain words,
crisp sentences, real names ("the Today screen") not file paths, max 5
bullets per group. Tech word unavoidable? Explain it in a few plain
words right after.

**Every reply uses two tables, in this order, under the same two
headings.** Founder request (2026-08-06): tables, not bullet lists, and
the two blocks stay split rather than merged into one table.

**Summary** (a plain-English title line)

| What                     | Detail               |
| ------------------------ | -------------------- |
| _short label, 2–4 words_ | _one plain sentence_ |

One row per thing that happened, 1–5 rows. The label column is the thing
("Footer", "Sprint 4", "Tests"), the detail column is the plain sentence.

**Status** (a plain-English title line)

|                         |                                      |
| ----------------------- | ------------------------------------ |
| **What I did**          | _finished actions_                   |
| **What you need to do** | _or "Nothing for now."_              |
| **What's next**         | _the upcoming work, or omit the row_ |

Then one clear question with the choices spelled out (e.g.
**start next ticket / pause**) if you need an answer.

Rules that still apply inside the tables:

- One sentence per cell. If a cell needs two, it is doing too much.
- No nested bullets, no code blocks, no `***` inside a cell.
- Plain words. A `path/to/file.ts:LINE` reference is fine; a wall of
  jargon is not.
- Keep the whole reply under ~150 words including both tables.
- Ordinary prose answers to a direct question do not need the tables:
  use them whenever the reply hands control back to the founder.

---

## Skill routing: when to use what

These are project-specific cues for when to invoke skills/agents. They do
**not** override the trigger conditions in each skill's own definition.

### Always

- **`using-superpowers`**: at the start of any conversation, surface
  relevant skills.
- **`verification-before-completion`**: never claim work is "done" without
  running the verification commands and confirming output.
- **`systematic-debugging`**: for any bug, test failure, or unexpected
  behavior, before proposing fixes.

### Planning & execution

- **`brainstorming`**: before any new feature, component, or behavior change.
- **`writing-plans`** / **`/write-plan`**: for multi-step tasks with
  specifications.
- **`executing-plans`** / **`/execute-plan`**: when working through a written plan.
- **`subagent-driven-development`** / **`dispatching-parallel-agents`**: when
  the plan has independent tasks that can be parallelized.
- **`planning-with-files`**: for research-heavy or >5-tool-call tasks.

### Implementation

- **`test-driven-development`**: for any feature or bugfix, before writing
  implementation code. The repo uses Vitest (unit) and Playwright (E2E).
- **`using-git-worktrees`**: for feature work that needs isolation.
- **`finishing-a-development-branch`**: when work is complete and ready
  to integrate.

### Code review

- **`requesting-code-review`**: before merging.
- **`receiving-code-review`**: when processing PR feedback.

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

- **`frontend-design`**: production-grade UI work.
- **`shadcn-ui`**: when integrating shadcn components.
- **`webapp-testing`**: interactive Playwright debugging of the local web app.

---

## Subagents

> **USE THE MATCHING AGENT: don't do specialist work inline when one fits.**
> This repo ships a curated set of agents in [`.claude/agents/`](.claude/agents/)
> (api-designer, backend-developer, code-reviewer, deployment-engineer,
> devops-engineer, documentation-engineer, frontend-developer,
> fullstack-developer, multi-agent-coordinator, product-manager, qa-expert,
> security-auditor, test-automator, typescript-pro). **Whenever a request maps
> to one of these (API design, a backend/frontend/full-stack build, a code
> review, a deploy, QA/test authoring, security review, docs, requirements),
> delegate to that agent via the Task tool rather than doing it inline.** Pick
> the most specific match; set the agent's model per Operating Rule G (Sonnet
> for most builds/reviews, Opus for genuinely hard calls). The project agents
> take precedence; fall back to the global set below for domains they don't
> cover.

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

## Multi-agent orchestration (workflows)

**Spin up multiple agents in parallel for substantial, fan-out-shaped
work**: either several `Agent` calls in one message, or the `Workflow`
tool for scripted fan-out → verify → synthesize. The founder has opted
in: use multi-agent orchestration **by default** on the task types below
without asking first. Don't fan out trivial or conversational work: a
single-file lookup or a two-line edit is faster solo.

Use it for:

- **Backlog / codebase audits**: classify many tickets or files in
  parallel, then verify + synthesize (e.g., the Jira backlog prune).
- **Code review at PR time**: `code-reviewer` + `qa-expert` in one
  parallel block (already mandatory, see [Pull requests](#pull-requests)).
- **Large refactors / migrations / sweeps**: one agent per file or
  call-site (worktree-isolated if they mutate in parallel), then a
  verify pass.
- **Research across many files / surfaces**: parallel readers, each
  blind to the others, → one synthesized summary.
- **Any "find everything" task**: fan out finders, dedupe, then
  adversarially verify each finding before acting.

How to do it well:

- **Scout first, then fan out.** List the work-items inline (the files,
  tickets, sites), then parallelise over that list.
- **Verify before acting.** For anything destructive or outward-facing
  (closing/cancelling tickets, deleting code, posting), have a second
  agent skeptically re-check each finding; default to keep/skip when
  unsure.
- **Synthesize yourself.** Read the agents' results and make the call:
  never hand a subagent the final decision.
- **Keep the human in the loop.** Present the plan and get a yes before
  executing consequential changes (e.g., cancelling Jira tickets).
- **Match the model to the job** (Operating Rule G): Sonnet for most
  classify / review / search agents; Opus only for genuinely hard calls.

---

## Repo conventions

### Commits

- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `perf:`.
- Reference the Jira key in the body or footer (e.g., `FHS-149`).
- Local repo identity is `toonday-fh <familyhubapp971@gmail.com>`, do not
  alter unless explicitly asked.

**Keep messages short and plain.** One-line subject under 70 chars. Body
is optional: add only when the _why_ isn't obvious from the diff or the
ticket. When a body is needed, max ~5 lines, plain language, no marketing
voice. Don't recap the diff (the diff already shows it). Don't list every
sub-decision and every nit you fixed; those live in the PR body or the
Jira ticket. **Goal: a future reader scanning `git log --oneline` learns
what changed; clicking through tells them why.**

Anti-pattern: 30-line commit messages with bulleted "What ships",
self-review notes, and follow-up trackers. That belongs in the PR body
or Jira comment, not the commit.

### Pull requests

- Target `staging` (not `main`) for feature work.
- **One PR per ticket. Finish one ticket completely before starting the
  next.** No parallel branches, no half-built features sitting in
  flight. A ticket is "complete" only when:
  - all relevant tests are written and green at every applicable tier
    (unit / integration / e2e, see "Test coverage per ticket" below),
  - PR opened, self-reviewed, CI green, merged to `staging`,
  - Jira ticket transitioned to Done with a structured close comment,
  - Confluence Epics & Tickets page refreshed.
    Only then branch for the next ticket. The single exception:
    reviewer-blocking polish pings on a still-open PR (those continue
    on the same branch, not a new one).
- **Merge style (conditional, per [ADR 0006](documents/decisions/0006-branching-strategy.md)):**
  - **Solo / 1 active contributor (current):** squash-merge feature → staging; merge-commit `staging → main`.
  - **≥2 active contributors:** switch to `--no-ff` merge commits at every level. Trigger: second person opens their first PR.
- Use the [PR template](.github/pull_request_template.md): it enforces
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
- **Always dispatch the `qa-expert` subagent in parallel with
  `code-reviewer`** for any ticket that ships user-facing flows, API
  endpoints, schema changes, or auth/multi-tenancy behaviour.
  `code-reviewer` checks the _code_; `qa-expert` enumerates the
  **flows + edge cases + missing-test scenarios** a real user could
  hit (race conditions, error paths, empty states, partial failures,
  unauthorized access, cross-tenant leakage, mobile/tablet/desktop
  responsive behaviour, accessibility hits, browser back-button,
  expired sessions, double-clicks, network drops, etc.). The two
  agents are launched **in the same parallel block** (single message,
  multiple Agent tool calls) so they run concurrently. Action every
  blocking finding from both before opening the PR; mention both in
  the Self-review section: _"Self-reviewed via code-reviewer +
  qa-expert subagents; X+Y findings actioned"_. Skip the qa-expert
  pass only on pure-internal changes (build config, test infra,
  CI tweaks, docstring-only edits) and say so explicitly in the
  PR body.

**Keep PR bodies short.** Default sections are: **Summary** (1-3 lines),
**AC trace** (one line per AC, pass/fail), and **Self-review** (one
sentence + count of blockers actioned). Add anything else only when it
genuinely changes how a reviewer evaluates the PR.

**Do NOT include a "Test plan" section.** Verification commands ran
locally and CI status are not artefacts the reviewer needs to read:
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

### Ticket fields: set on EVERY ticket (all types)

**Rule:** Whenever you create or pick up **any** Jira ticket (Story, Task,
Bug, Epic, Sub-task), these three fields must be set. Don't leave them
blank and don't wait to be asked.

1. **Story point estimate** (`customfield_10016`, a number): always
   estimate, even Bugs and chores. Use Fibonacci: `1` trivial · `2`
   small · `3` normal · `5` chunky · `8` large multi-surface · `13`
   epic-sized (split it). Epics: set the rolled-up total or leave the
   children to carry it, but the stories/tasks/bugs always get a number.
2. **Team** (`customfield_10001`): always **Family Hub SaaS** (team id
   `b6dcc0ad-3de2-44eb-802b-2804ad35ef3c`). New tickets usually inherit
   it; if a ticket shows Team = None, set it.
3. **Labels** (`labels`, array): at least one **area** label plus the
   touched **surface(s)**. Areas: `childworld`, `myworld`, `learn`,
   `meals`, `calendar`, `members`, `auth`, `billing`, `admin`,
   `tenancy`, `infra`. Surfaces: `frontend`, `backend`, `data`,
   `tests`, `docs`. Bugs also carry `bug`; manual-test tasks carry
   `manual-test`, `qa`, `sprint-N-close` (per the demo-testing rule).

Set these alongside the existing required fields (parent epic, Sprint,
Fix Version per the rules below). Quick backfill pattern (`PUT` the
issue):

```bash
curl -s -u "$EMAIL:$JIRA_API_TOKEN" -X PUT \
  "$URL/rest/api/3/issue/FHS-XXX" -H "Content-Type: application/json" \
  -d '{"fields":{"customfield_10016":5,"labels":["childworld","frontend"]}}'
```

### Branch & PR naming (Jira auto-link)

**Rule:** Every Jira ticket gets its own feature branch. **Never commit
directly to `staging` or `main`**: always branch first, even for
single-file changes.

The Jira ↔ GitHub integration links commits, branches, and PRs to FHS
tickets when the ticket key appears in the name. Use:

- **Branch:** `<type>/FHS-XXX-short-slug`: short and identifiable, 2–4
  kebab-case words. Examples:
  - `feat/FHS-149-stack-scaffold`
  - `fix/FHS-12-tenant-ctx-async`
  - `documents/FHS-146-claude-md-rules`
- **PR title:** `<type>(FHS-XXX): short summary`, e.g.,
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
> **Manual fallback**: if the automation rule is disabled or fails,
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
the ticket must be commented and closed, automatically, without the
user asking.

Steps:

1. Verify the merge landed on `main` (and `staging` is in sync if a
   promotion PR was used).
2. Post a **brief, structured** comment on the Jira ticket using ADF
   `bulletList` / `heading` blocks. Never dense prose. 4–8 bullets is
   the target: cover what was delivered, the PR number(s), any
   caveats / follow-ups, and the next ticket if known.
3. Transition the ticket to **Done** (transition ID `31` for FHS;
   confirm via `GET /rest/api/3/issue/<KEY>/transitions` if unsure).
4. If the work has caveats / partial completion, still close, but list
   the caveats under a "Caveats" or "Follow-ups" section in the comment.

The closing comment is part of the deliverable, not a separate task.
Drift between merged code and ticket status is a process bug.

After the transition, **refresh the Confluence "FHS: Epics & Tickets"
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

### Document design: low cognitive load (every doc, every time)

Founder rule (2026-08-04): every document produced in this repo
(briefs, demo decks, strategy PDFs, one-pagers) is built for a reader
on the move. Non-negotiables when building or editing ANY doc:

- One idea per element: short bullets over paragraphs, labeled
  micro-sections over run-on prose, tables for enumerable facts.
- Air is a feature: generous padding between sections, rows and
  tables. Never squash content to force a page count; add a page
  instead.
- Visible hierarchy, deck design language: lavender paper `#F6F1FA`,
  deep-purple `#3d1065` hero panels with white type, candy pill
  palette, black borders, hard offset shadows, Fredoka One + Nunito.
- Body text never below ~9.5pt in the rendered PDF; wide layouts go
  landscape or split across pages rather than shrinking type.
- No element may split across a page break; flowing docs render with
  real top/bottom page margins.
- Verify like a founder: rasterize every page of the rendered PDF and
  look at it before shipping. If a page reads as a wall of text,
  restructure it; don't ship and wait to be told.
- Render business docs with `node scripts/render-docs.mjs` (all
  doc-src sources, correct orientation, margins and running footers);
  the demo deck renders with `node scripts/render-demo-pdf.mjs`.

### Demo doc follows every user-visible merge

**Whenever a merged ticket changes what a user can see or do**, refresh
the shipped-state demo doc in the same session, not just at sprint
close. Founder request (FHS-552, 2026-08-03): the demo page is the
founder's single view of the live product and must never lag reality.

- Edit the source `scripts/demo-src/whats-shipped.src.html`: add/update
  the capability card in the matching section (plain words, persona
  chips, FHS key chip), bump the "Last updated" stamp and the "current
  through FHS-XXX" marker in the hero.
- Render the committed artefact with `node scripts/render-demo-pdf.mjs`
  → [`documents/demo/whats-shipped.pdf`](documents/demo/whats-shipped.pdf).
  **Docs folders are PDF-only** (no .html artefacts in `documents/`);
  commit source + PDF together.
- Keep it visual and in the design language (kingdom purple, Fredoka
  One + Nunito, black borders, offset shadows), it's a demo prop, not
  a changelog.
- Internal-only merges (CI, tests, refactors, docs) skip this; if
  skipped on a user-visible ticket, say why in the close comment.
- **The QA feature-tour brief follows the same rule.** When shipped
  features change, update
  `scripts/doc-src/fh-qa-brief-feature-tour.html` and
  re-render `documents/business/fh-qa-brief-feature-tour.pdf`
  in the same session, so external testers always hold a current map
  of the product.

### Epic status follows its children

An epic's status always mirrors the state of its children:

- **First child enters In Progress** → transition the epic from
  **To Do → In Progress** (transition id `21` for FHS).
- **All children Done** (treat "Won't Do" / "Cancelled" as Done) →
  transition the epic to **Done** (id `31`) with a brief structured
  comment listing each child story it delivered. Don't make the user
  chase epic closure: same logic as the post-merge ticket close,
  one level up.
- If an epic is already at the target status, skip: don't re-transition.
- **Post-launch bugs are the exception.** Every bug hangs off its
  feature epic (see "Fixing bugs"), so a Done epic will accrue bug
  children after it ships. Those do **not** reopen the epic: once an
  epic is Done it stays Done; the bug is tracked under it purely for
  traceability. Only an _open story/task_ child (real remaining
  feature scope) moves a Done epic back to In Progress.

After any epic transition, **refresh the Confluence "FHS: Epics &
Tickets" page** per the Confluence-refresh step in the "Closing
tickets" section above.

### Fix Versions: Sprint cluster releases

The FHS project uses **Fix Versions** to mark Sprint cluster releases,
mapped 1-to-1 to the Sprint-to-milestone table in
[`documents/strategy/saas-transformation.md`](documents/strategy/saas-transformation.md):

| Version                  | Sprint cluster                |
| ------------------------ | ----------------------------- |
| `0.0-bootstrap`          | Sprint 0: Bootstrap (current) |
| `0.1-tenant-foundation`  | Sprint 1                      |
| `0.2-signup-custom-url`  | Sprint 2                      |
| `0.3-modules-gating`     | Sprint 3                      |
| `0.4-stripe-billing`     | Sprint 4                      |
| `0.5-invites-roles`      | Sprint 5                      |
| `1.0-white-label-launch` | Sprint 6 (GA)                 |

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

### End-of-sprint demo manual testing

Every sprint close ships a founder-facing manual E2E test pass. The
parent Jira epic
[**FHS-254: End-of-sprint demo E2E manual testing**](https://qualicion2.atlassian.net/browse/FHS-254)
collects one child Task per sprint (e.g. FHS-251 for Sprint 2). The
child is the demo checklist: every user-visible flow shipped that
sprint, ticked Pass / Fail / Blocked.

**Trigger:** when a sprint's last code ticket closes (before
transitioning the sprint complete in the board), create the child
Task. Don't wait for the user to ask.

**Steps (autonomous, no permission needed):**

1. Create a new **Task** under FHS-254:
   - Summary: `test: manual E2E test pass, Sprint N (<theme>) close`
     (e.g. `test: manual E2E test pass, Sprint 3 (Modules & Gating) close`).
   - Parent: FHS-254.
   - Sprint: the closing sprint (e.g. 442 for Sprint 3).
   - Fix Version: the closing sprint's cluster (e.g. `0.3-modules-gating`).
   - Labels: `manual-test`, `qa`, `sprint-N-close`.
2. Body is a **tabular checklist**, never prose. Structure:
   - One section per epic shipped that sprint (e.g. Section A =
     epic FHS-XXX).
   - Within each section, a markdown table with columns:
     `# | Step | Expected outcome | Result | Notes`.
   - Rows numbered with a section letter (`A1`, `A2`, …).
   - Plus a **Summary** table at the bottom with `Pass / Fail /
Blocked` totals + counts of new bug docs filed.
   - Plus a **Known bugs already filed** table linking
     `bugs/<slug>.md` files to the row numbers they affect.
3. Mirror the body to a markdown file at
   `bugs/manual-e2e-sprint-N-test-pass.md` so the founder can edit
   it during the demo. Frontmatter: `status: in-jira: FHS-XXX`,
   `sprint: <id> (Sprint N: <theme>)`, `type: manual-test-pass`.
4. Append a "Children" bullet to FHS-254's description body (already
   has the list, just append the new key).
5. Tell the user the demo sheet is ready + link both the Jira ticket
   and the local markdown path.

**Definition of done (per child):**

- Every row has Result + Notes.
- Summary totals filled in.
- A bug doc filed in `bugs/` for every Fail (with `status: in-jira:
FHS-XXX` once promoted).
- Summary commented back on the child Task; transition to Done.
- Demo doc (`documents/demo/whats-shipped.html`) refreshed if any
  shipped flow needs revision based on what the test pass found.

### Every reported bug gets logged: no exceptions

> **The moment the founder reports a bug (a screenshot, "this is broken",
> "X overlaps Y", "still misaligned", etc.), it MUST be logged as an FHS
> Bug ticket immediately (before or alongside fixing it) so it can be
> picked up and tracked. Never fix-and-forget without a ticket, and never
> wait to be asked to file it.** This is automatic, like the
> branch-creation and ticket-close rules.

How to apply:

- On a bug report, **first** create the FHS Bug (To Do, current sprint,
  matching Fix Version, parent = the feature's epic, story points, plus
  area and surface labels, a one-line layperson summary, three technical
  bullets, and Gherkin AC) per the lifecycle below, even if you fix it in
  the same session. If several bugs are reported in one message, log each.
- If the bug is genuinely trivial and fixed in the same turn, still file
  the ticket and close it on merge: the audit trail is the point.
- Mirror to `bugs/<slug>.md` only when it feeds the manual-test sheet
  (per the demo-testing rule); the Jira ticket is always required.

### Fixing bugs (workflow)

When picking up a bug from `bugs/<slug>.md` (or any `Bug` Jira
ticket), follow the same lifecycle as a feature ticket, but with a
few bug-specific steps front-loaded so the manual-test sheet stays
in sync. **Always do this before writing any fix code**:

1. **Promote the bug doc to Jira if not already.** If the doc has
   `status: open`, create the matching FHS Bug ticket: short plain-
   language title (no `bug:` prefix in summary), one-line layperson
   summary in bold, 3 short technical bullets, 3 Gherkin acceptance
   criteria. Update the doc's frontmatter to
   `status: in-jira: FHS-XXX`.
2. **Sprint + Fix Version + Epic.** Add the bug to the current active
   sprint and tag with the matching cluster Fix Version
   (`0.0-bootstrap` etc.). **Set the bug's parent to the feature's
   epic**: the epic that delivered the feature the bug lives in
   (e.g. a My World bug → parent `FHS-290`). Every bug must hang off
   its feature epic for traceability:

   ```bash
   curl -s -u "$EMAIL:$JIRA_API_TOKEN" -X PUT \
     "$URL/rest/api/3/issue/FHS-XXX" -H "Content-Type: application/json" \
     -d '{"fields":{"parent":{"key":"FHS-<epic>"}}}'   # 204 = linked
   ```

   If you can't identify the feature epic, ask before filing the bug:
   don't leave it parentless. (A post-launch bug on an already-Done
   epic does NOT reopen the epic: see "Epic status follows its
   children".)

3. **Link to the active manual-test child Task.** Use a Jira
   "Blocks" link from FHS-251 (or the current sprint's child of
   FHS-254) → the bug ticket. This keeps the manual checks ticket
   honest about what still needs verifying.
4. **Transition to In Progress.** The branch-creation Automation
   covers this for new branches matching `<type>/FHS-XXX-…`, but
   the bug-fix branch may use a slug-only name (`fix/<slug>`); when
   the branch name doesn't carry the FHS key, transition manually
   via the API (`POST /rest/api/3/issue/<KEY>/transitions` with
   transition id `21`).
5. **Branch.** `fix/FHS-XXX-short-slug` (so Jira auto-In-Progress
   fires for free), or `fix/<descriptive-slug>` if step 4 was used.
6. **Fix.** Smallest viable change; resist refactoring around it.
7. **Add tests that lock the fix.** A unit test that fails on the
   pre-fix code and passes on the fixed code is the floor.
   Integration / E2E only when the bug touches multi-layer
   behaviour. The test name should describe the bug, not the
   implementation (e.g. `bar centres on the circle row when labels
are present`).
8. **Run code-reviewer + qa-expert in parallel** on the diff:
   same rule as feature tickets. Action every blocker before PR.
9. **PR + CI + squash-merge + Jira close.** Same lifecycle as a
   feature ticket: see "Closing tickets" + "Pull requests" above.
10. **Update the manual-test sheet.** After merge, edit the
    relevant row in `bugs/manual-e2e-sprint-N-test-pass.md` (and
    the FHS-251 / current child Task description) to add a
    "FIXED in FHS-XXX, re-verify" note in the Notes column for
    every row that referenced the bug. Flip the bug doc's
    frontmatter to `status: fixed` and leave it in `bugs/` as a
    historical record (don't delete: future regressions need
    context).

**Anti-pattern:** start coding before the bug is in Jira / In
Progress / linked to FHS-251. The link is what keeps the manual
test pass sane: without it, fixed bugs leave stale rows in the
sheet that get re-flagged the next sprint.

### Decisions log sync

ADRs in [`documents/decisions/`](documents/decisions/) are the canonical record of
project shape. **When an ADR is added, superseded, or materially edited,
propagate the change across every surface that references it** in the
same PR (per bundling) or the same session (for Jira / Confluence):

| Surface                                                                                  | What to update                                                                     |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `documents/decisions/<NNNN>-<slug>.md`                                                   | The ADR file itself                                                                |
| `documents/decisions/README.md`                                                          | Index entry: accepted / superseded marker                                          |
| Root [`README.md`](README.md)                                                            | ADR list entry (if present)                                                        |
| [`documents/strategy/saas-transformation.md`](documents/strategy/saas-transformation.md) | Architecture table row pointing at the ADR                                         |
| `CLAUDE.md`                                                                              | Any conventions section that references the ADR                                    |
| Jira: epic comment                                                                       | Structured comment summarising the ADR + linking to repo                           |
| Jira: child tickets                                                                      | Comment on any open ticket whose scope shifts (header: "Scope adjusted: ADR XXXX") |
| Confluence: "Family Hub: Vision & Strategy" → "Architecture & multi-tenancy"             | Update architecture table row                                                      |
| Confluence: "FHS: Epics & Tickets"                                                       | Refresh via builder (per the Confluence-refresh rule)                              |

Cross-link both ways: the ADR file links to the Jira ticket(s) it
answers; those tickets link back to the ADR. Never delete a superseded
ADR: flip its `Status:` line to `superseded by NNNN`. After any
update, re-read at least the strategy doc + Architecture Confluence
page to confirm they don't still reference the dead decision.

### Feature impact analysis (pre-implementation)

Before writing implementation code for **any** feature, ticket, or
behaviour change, produce a short impact analysis covering at minimum
**frontend**, **backend**, and **infrastructure**. Surface it to the
user and wait for acknowledgement before starting the work: this
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
genuinely untouched: silence is not the same as "no impact"):

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
**Impact analysis: FHS-XXX**

- **Frontend:** <bullets, or "no impact: server-only">
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

The analysis is not a separate Jira ticket: it's a comment on the
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
| Architecture           | ADRs in `documents/decisions/`: write a new ADR or supersede an existing one                        |
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

### Design system (packages/ui): single source of truth

**Any design change updates the design system in the same PR.** When a
ticket introduces or alters a visual component (badge styles, role
colour maps, chips, stat tiles, progress bars, avatar discs, form
shells), the reusable piece lives in `packages/ui`: never copy-pasted
across pages. Rules:

- New component used (or clearly usable) by 2+ pages → extract to
  `packages/ui/src/<Name>.tsx`, export from `index.ts`, unit-test it
  under `tests/unit/ui/`.
- Shared visual constants (role → colour/label maps, pastel palettes,
  status chip styles) live in `packages/ui`, not per-page consts.
- When matching a Magic Patterns design, port the mock's component into
  the design system first, then consume it from the page.
- Drift check at PR self-review: if the diff adds a styled block that
  already exists elsewhere, consolidate before merging.

### Code style

- **No em dashes, ever.** Not in UI copy, docs, PDFs, commits, Jira
  comments, README files, or marketing content (founder rule,
  2026-08-03). Use a comma, colon, parentheses or a period instead.
  Removal of pre-existing ones across the repo is tracked in FHS-553.
- TypeScript strict mode everywhere.
- 2-space indent, LF line endings, UTF-8 (enforced by `.editorconfig`).
- No comments unless the _why_ is non-obvious.
- Avoid premature abstraction: three similar lines beats a wrong helper.

### Secrets

- All secrets live in `.env.local` (gitignored) or Railway/Supabase env vars.
- Never commit tokens, API keys, or `.env*` files. GitHub secret scanning +
  push protection are enabled on the repo as a backstop.

### Multi-tenancy

- Every table that holds tenant data carries `tenant_id`.
- Postgres RLS policies enforce isolation: never bypass with `bypassrls`.
- Tenant context is set per-request in API middleware (FHS-12).

### Responsive design (mobile / tablet / desktop)

> **NON-NEGOTIABLE: applies to EVERYTHING built, every PR, no exceptions.**
> Any new or changed UI (page, panel, dialog, card, table, form) must be
> mobile- **and** tablet-friendly before it ships, not just "good on a
> laptop". This is a merge gate: the responsive sweep below is required, and
> the PR self-review must state it was done. When in doubt, build mobile-first
> and scale up. If a layout can't be made to work on a phone, raise it before
> coding, don't ship a desktop-only screen.

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
  `prefers-reduced-motion` users see colour changes only, and pointer-
  device-only via `@media (hover: hover)` if the effect is jarring on
  touch devices.
- Test in dev across at least three breakpoints before opening a PR:
  open Chrome DevTools → device toolbar → toggle iPhone, iPad, Desktop.
- Include a **"verified across breakpoints"** line in PR self-review
  notes for any UI ticket.
- **Magic Patterns hand-offs are not exempt.** When a change ports a
  Magic Patterns design, check whether the generated layout already
  handles mobile and tablet. If it does, verify it at all three
  viewports; if it does not (MP output is often desktop-biased), design
  and build the mobile/tablet behaviour yourself in the same change:
  stack columns, collapse nav, wrap tables in `overflow-x-auto`, resize
  tap targets. Never ship the desktop-only interpretation of a mock.
- **Responsive tests are part of done.** Every UI ticket ships tests
  that exercise the changed surface at mobile and tablet widths, not
  just desktop: run the relevant Playwright scenario on the
  mobile-chrome project (or set a 375px / 768px viewport explicitly)
  and assert the layout-critical behaviour (no horizontal scroll on the
  main flow, nav reachable, primary actions visible and tappable).
  Where a component branches on viewport, unit-test that logic too. A
  UI PR with desktop-only tests is incomplete.

The "make it look good on Sarah's MacBook" reflex is fine for first
draft; the responsive sweep is **not optional** before merge: Family
Hub's adult users are 70%+ on phones in the field (per persona doc).

---

## Local-only conventions

These mirror the global rules in `~/.claude/CLAUDE.md` but are repeated
here for emphasis on this repo:

- **Never** update `git config` (local or global) without asking.
- **Never** run destructive git commands (`reset --hard`, `push --force`,
  `branch -D`, `clean -f`) without explicit user authorization.
- **Never** skip hooks (`--no-verify`, `--no-gpg-sign`) without explicit ask.
- **Never** create planning, decision, or analysis docs unless asked:
  ADRs in `documents/decisions/` are the exception (created via FHS-171/172/174).

### gh / git account safety

The Mac has multiple GitHub accounts logged into `gh` (`qualicion`,
`familyhubapp971`, `BabatundeOduniyi-ext_adcb`). This repo is owned
by **`familyhubapp971`**: only that account has push + PR-merge
permission. Most commands (`gh pr checks`, `gh api`, `gh pr view`)
work from any account, but anything that **mutates the repo**
(`git push`, `gh pr create`, `gh pr merge`, `gh pr close`, branch
creation on the remote) fails with `403` or
`does not have the correct permissions` when the active gh account
isn't `familyhubapp971`.

Before running any push / PR-create / PR-merge / branch-push command:

1. Check the active account: `gh auth status 2>&1 | head -5`
   (look for the `Active account: true` line under `familyhubapp971`).
2. If the active account is anything else, switch:
   `gh auth switch --user familyhubapp971`.
3. If the switch fails with a keyring timeout (e.g. another
   `gh`/`git` invocation is mid-flight holding the keyring lock),
   **wait for that command to finish** before retrying: don't
   force-kill or sleep-loop. A second retry of `gh auth switch
--user familyhubapp971` after the other command completes is
   usually enough.

Read-only commands (`gh pr checks`, `gh pr view`, `gh api`,
`gh run view`) do not require switching: they work fine from any
authenticated account.

Concrete pattern that's safe to embed in any push/merge step:

```bash
# Ensure we're pushing as the repo owner.
gh auth switch --user familyhubapp971 2>&1 | tail -1
git push -u origin <branch>
```

Anti-pattern: pushing without checking, getting a confusing
`Permission to use Bash with command git push has been denied` or
`403`-style failure, then retrying without switching the account:
the failure isn't a permission denial from the tool, it's GitHub
rejecting the push because the wrong account is active.

---

## Explaining decisions: keep it simple

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
  features/         # what & why: owned by product-manager agent
    <feature-slug>.md
  technical/        # how: owned by engineering subagents
    architecture.md
    deployment.md
    slos.md
    api/
    data-model/
  decisions/        # ADRs: durable choices, immutable once accepted
    NNNN-kebab-case.md
  strategy/         # long-form strategy docs (vision, positioning, transformation)
    <topic-slug>.md
```

- `documents/features/`: user-facing requirements: personas, user stories,
  acceptance criteria, success metrics, scope boundaries.
- `documents/technical/`: implementation specs derived from features:
  API contracts, schemas, sequence diagrams, infra topology, SLOs.
- `documents/decisions/`: ADRs in MADR-lite format; see the
  [ADR section](#architecture-decision-records-adrs) below.
- `documents/strategy/`: long-form direction-setting docs that inform
  the features backlog.
- Every feature should have a corresponding technical doc once
  implementation begins. Cross-link both directions.

Each subfolder has its own `README.md` documenting purpose, when to add a
doc, and naming convention: read those before adding to the folder.

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

### Keep feature docs in sync with what shipped: ALWAYS

> **Founder reminder (2026-08-06): this keeps getting skipped. Every change,
> every time.** Before opening ANY pull request, ask "which file in
> `documents/features/` describes what I just changed?" and update it in that
> same PR. Design ports count. Bug fixes count. Copy changes count. If the
> answer is "none exists", write one. If the answer is genuinely "no user-
> visible behaviour changed", say so explicitly in the PR self-review. A PR
> that silently leaves the feature docs behind is not finished.
>
> The doc records what SHIPPED, not what was planned, and lists every
> deliberate deviation from the design with the reason, so a future reader
> can tell a decision from an accident.

> **NON-NEGOTIABLE, EVERY TIME behaviour or requirements change.** The moment a
> feature is built, changed, tightened, redesigned, or has a bug fixed that
> alters how it behaves, the matching `documents/features/<slug>.md` MUST be
> created or updated in the SAME session/PR: never "later", never a follow-up
> ticket. This is a merge gate: a PR that changes behaviour without touching the
> feature doc (or stating in self-review why none applies) is incomplete. If no
> doc exists yet for the touched feature, create one. Do this automatically,
> without being asked.

Use the user-story + Gherkin template above, written from the **shipped
behaviour** (not the original pitch) so it stays accurate. Cross-link every Jira
key the feature shipped under and any ADR that governs its design (e.g.
`**ADR:** [0020: ...](../decisions/0020-...md)`). When a design change lands
across several tickets, list them all. **Drift between shipped behaviour and
`documents/features/` is a bug**, treat it like any other bug: fix it in the
same change, don't just note it. This is the exception to the
"never create docs unless asked" local rule: feature docs in
`documents/features/` are always expected to track reality.

### Keep the ticket's acceptance criteria in sync too

**Every ticket carries Given/When/Then acceptance criteria, and those AC MUST
track what actually gets built.** Add Gherkin AC when you create or pick up a
ticket (not just a title), and **when the build refines or changes the
behaviour, update the ticket's AC to match what shipped**: in the same
session, before closing. The closing comment then maps each AC to the shipped
behaviour (pass/fail), so the ticket reads true to what's live. An AC that
describes behaviour the code doesn't have (or omits behaviour it does) is drift:
fix it like any other drift. This applies to Stories, Tasks, and Bugs alike.

---

## Testing

Four test tiers under one **centralized** `tests/` directory at the repo
root: never colocated next to source. Mirrors the legacy family-hub
layout, reorganised by package within each tier.

### Test coverage per ticket

**Every ticket must ship with the test tiers that apply to its scope.**
A ticket isn't done (and the PR isn't mergeable) until the right
tiers are green. Use this matrix to decide what's required:

| Ticket scope                                           | Unit                              | Integration                       | E2E                                                             | Perf              |
| ------------------------------------------------------ | --------------------------------- | --------------------------------- | --------------------------------------------------------------- | ----------------- |
| Pure logic / utility / type-only                       | required                          | n/a                               | n/a                                                             | n/a               |
| `packages/ui` primitive (Button, Card, PinInput, etc.) | required (per prop / interaction) | n/a                               | n/a                                                             | n/a               |
| API endpoint or middleware                             | required (handler logic)          | required (real Postgres + RLS)    | required if user-visible                                        | smoke if hot path |
| Page / route (apps/web)                                | required (component shape)        | n/a                               | required (Gherkin scenario from `documents/features/<slug>.md`) | n/a               |
| Schema migration                                       | required (drizzle-kit dry-run)    | required (RLS + tenant-isolation) | required if it affects a user flow                              | n/a               |
| Cross-cutting (auth, feature flag, billing)            | required                          | required                          | required (full happy + sad path)                                | smoke             |

Rules of thumb:

- **Unit**: fast (<200ms each), no I/O, mocks for collaborators.
  Asserts ONE thing per test. Never mock the unit under test.
- **Integration**: real Postgres + real network. Always include a
  tenant-isolation scenario for any tenant-scoped table or endpoint.
- **E2E**: `tests/e2e/features/<slug>.feature` scenario names must
  match the Gherkin scenarios in `documents/features/<slug>.md`
  character-for-character. That's the Jira AC ↔ test traceability
  contract.
- **Perf**: only when the change touches a hot path (request handlers,
  list endpoints, anything in the dashboard fan-out). k6 smoke is
  enough for most tickets; load/stress run pre-release.

If a ticket genuinely has no testable surface (pure docs, pure config),
say so explicitly in the PR self-review section. Don't ship "no tests
needed" silently: that's how regressions creep in.

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
`packages/shared`) keep working: their `include` glob points at
`../../tests/unit/<pkg>/`.

> **Current state (2026-04-25):** test files added in FHS-150 / FHS-151
> are temporarily colocated. Migration into `tests/unit/<pkg>/` is
> tracked as part of [FHS-186](https://qualicion2.atlassian.net/browse/FHS-186)
> ("one green test per tier") so it lands together with the integration /
> e2e / perf hello-world scaffolds. **All new test files from this point
> on must be created under `tests/<tier>/...`, not colocated.**

### Unit: Vitest

- **Where:** `tests/unit/{api,web,shared}/...` mirroring source hierarchy.
- **File naming:** `*.test.ts` / `*.test.tsx` (reserve `*.spec.ts` for integration).
- **Run:** `pnpm test` (root, via `vitest.workspace.ts`, runs all packages); `pnpm test:watch`; `pnpm test:coverage` for merged lcov.
- **Environment:** `node` for api + shared; `jsdom` + `@testing-library/react` for web.
- **Coverage thresholds (starting):** lines 70%, branches 60%, functions 70%: raise to 80/70/80 after FHS-186 baseline. Hard-gating only after thresholds calibrate.
- **Scope:** pure functions, single class/module, no I/O. Mock external collaborators, **never** mock the thing under test.

### Integration: Vitest + Cucumber + real Postgres

- **Where:** `tests/integration/features/*.feature` (Gherkin scenarios) bound by `tests/integration/steps/*.steps.ts` (Vitest step definitions). Powered by [`@amiceli/vitest-cucumber`](https://github.com/amiceli/vitest-cucumber): same BDD style as the E2E tier (FHS-218).
- **Config:** dedicated `tests/integration/vitest.config.ts` includes both `steps/**/*.steps.ts` (current) and `specs/**/*.spec.ts` (legacy, drained as scenarios migrate).
- **Run:** `pnpm test:integration`: spins Postgres 16 via `docker-compose.test.yml` on port 5433 (offset from dev's 5432). CI uses GitHub Actions `services:` block.
- **Setup:** drop + recreate test DB, `drizzle-kit push --force` to apply schema + RLS policies. Each scenario starts from a clean state via `Background:` in the .feature file (typically `TRUNCATE` or per-scenario seed).
- **Mandatory pattern:** every feature touching a tenant-scoped endpoint includes a `tenant isolation` scenario: tenant B reads return zero rows from tenant A. Defence in depth for [ADR 0001](documents/decisions/0001-multi-tenancy.md).
- **Cover the edges, not just the happy path:** boundary timestamps, oversized payloads, malformed Authorization headers, concurrent fan-out, unique-constraint races. The unit tier covers shape; integration covers what real Postgres + real network do.
- **Pool:** test pool is `max: 2`, `idle_timeout: 5`, separate from the prod pool. Lives in `tests/integration/support/db.ts` against `DATABASE_URL_TEST`.
- **Never mock the database**: mocked DBs hide RLS regressions and migration breakage.
- **`.feature` ↔ `.steps.ts` pairing convention:** one feature file ↔ one steps file, same slug. Step definitions are `Given`/`When`/`Then`/`And` callbacks inside `describeFeature(...)` blocks. `Background` runs before every scenario in that feature.

### E2E: Playwright + playwright-bdd

- **Where:** `tests/e2e/`. Two configs: `playwright.config.ts` (full matrix) and `playwright.critical.config.ts` (`@critical`-tagged subset, chromium only).
- **Traceability contract:** scenario names in `tests/e2e/features/<slug>.feature` are **character-for-character identical** to the Gherkin scenarios in `documents/features/<slug>.md`. `bddgen` generates the spec; the generated `test()` name carries through. This is the Jira AC ↔ test traceability mechanism.
- **Page objects:** `tests/e2e/support/pages/<FeatureName>Page.ts`. No raw `page.locator()` in step files.
- **Authenticated pages (FHS-516):** a spec that needs a signed-in `/t/:slug/*` page imports `test`/`expect` from `tests/e2e/support/fixtures.ts` (not `@playwright/test`) and depends on the **`authedFamily`** fixture: it seeds a fresh isolated family + admin/child/habit, mints an ES256 JWT the local api trusts (via the test-only `E2E_TEST_JWKS` override in `apps/api/src/middleware/auth.ts`, honoured **only** under `NODE_ENV=test`), and injects a supabase-js session into `localStorage`, so the spec can `page.goto('/t/<slug>/…')` already logged in. The configs point the web dev's `VITE_API_URL` at the local api so the browser hits the api that trusts the test token. `authed-smoke.feature` is the reference example.
- **Browser matrix:** chromium only on PR (critical subset, fast); full matrix (chromium + webkit + mobile-chrome) post-merge to staging.
- **Run:** `pnpm test:e2e` (full), `pnpm test:e2e:critical` (PR-fast subset), `pnpm test:e2e:ui` (interactive). Each script runs `bddgen` first then `playwright test`.

### Performance: k6

- **Where:** `tests/performance/scenarios/{smoke,load,stress,soak}.js` with shared helpers in `tests/performance/scripts/`.
- **Multi-tenancy add-ons** vs family-hub: per-tenant VU groups (split VUs across 2–3 synthetic tenants to validate RLS overhead under concurrent load); `withTenantHeader(tenantSlug)` helper.
- **Thresholds:** defined in `tests/performance/config.js`, tied to `documents/technical/slos.md` (p95 < 250 ms read, p95 < 500 ms write: until SLO doc lands, those are the working targets).
- **Schedule:**
  - `smoke`: every CI run after integration (30s, 1 VU).
  - `load`: nightly against staging.
  - `stress`: pre-release, before staging → main promotion.
  - `soak`: weekly Sunday nightly run.
- **Run locally:** `pnpm perf:smoke`, `pnpm perf:load`, etc.

### Cross-tier rules

- **No mocking the DB in integration or E2E.** Real Postgres is mandatory.
- **Test names mirror Gherkin scenario names** for automatic AC traceability.
- **A feature is not "done"** until its tier-appropriate tests pass green in CI: the pre-merge checklist enforces this.
- **Shared test utilities live in `packages/test-utils`** (FHS-184): `withTenant()`, factories, `testDb`, RTL render wrapper, MSW handlers, `makeRequest()`. Never duplicate these in test files.
- **Pipeline orchestration** (per the test-automator design):
  - **PR CI (must finish < 5 min, gates merge):** unit + integration + e2e-critical + typecheck (parallel jobs).
  - **Post-merge to staging:** e2e-full matrix + perf smoke.
  - **Nightly:** perf load (daily) + perf soak (weekly Sunday).
  - **Pre-release:** perf stress before staging → main batch promotion.

---

## API contracts (OpenAPI / Swagger): NON-NEGOTIABLE

> **Every API endpoint MUST be documented in the OpenAPI/Swagger spec, and the
> spec MUST be updated in the SAME PR as any change to the API surface.** This is
> a merge gate, not a nice-to-have. A new/changed/removed route, request shape,
> response shape, status code, header, or error envelope that isn't reflected in
> the committed spec is an incomplete PR. "I'll document it later" is the
> anti-pattern this rule exists to kill: the spec is how the frontend, mobile,
> and any future consumer know what the API does without reading the handler.

The rule (apply to every API ticket, every time):

- **Single source of truth:** the spec at `apps/api/openapi.json` is
  **generated from the live Hono route table** (FHS-356), so EVERY mounted
  endpoint is documented automatically: a new/removed route shows up in the
  regenerated spec with no manual list to maintain. A human-browsable **Swagger
  UI** is served at **`/docs`** (raw spec at **`/openapi.json`**). Secure by
  default: ON in dev/test/staging, **OFF in production** unless
  `API_DOCS_ENABLED=true` is set (staging sets it explicitly).
- **Enrich the contract.** Path + method coverage is automatic; the
  request/response **shape** comes from the handlers' own Zod schemas via the
  registry at `apps/api/src/openapi/registry.ts`. When you add or change an
  endpoint, add/extend its entry there (summary + request + response schema)
  so the docs show the real contract, not just the path.
- **Regenerate + commit in the same PR.** After any route or schema change run
  `pnpm -F api openapi:generate` and commit the updated `apps/api/openapi.json`
  so the diff is reviewable. The PR self-review must confirm the spec was
  regenerated (or state the API surface was untouched).
- **Breaking changes** (removed/renamed fields, changed types, removed
  endpoints, changed status codes) bump the API version in the spec and add a
  `breaking` label on the PR.
- **CI gate (enforced):** the `typecheck` job runs `pnpm -F api openapi:check`,
  which regenerates the spec and fails if `openapi.json` is stale, so drift
  cannot merge.
- **Pre-merge checklist** (below) and the **change-impact** table both list the
  spec: touching the API means touching the spec, full stop.

> **Status: wired (FHS-356).** Generator (`openapi:generate`), staleness gate
> (`openapi:check` in CI), Swagger UI at `/docs`, and a registry enriching the
> core endpoints are all live; every endpoint is covered at the path/method
> level. Remaining work is incremental: enrich the request/response schemas of
> the non-core endpoints in the registry over time (each is a small, additive
> change: the path itself is already documented).

This section will grow as the API matures: auth schemes, pagination
convention, error envelope, rate-limit headers, etc.

---

## Architecture Decision Records (ADRs)

ADRs live in `documents/decisions/`. One file per decision:
`NNNN-short-title.md` (zero-padded sequential numbering, kebab-case).

Write an ADR whenever you make a decision that:

- changes the shape of the system in a way someone might later question,
- chooses one viable option over another (e.g., Postgres vs DynamoDB),
- locks in a constraint future contributors need to respect.

Don't write an ADR for routine implementation choices: only for the
ones future-you would want context on.

Template (Nygard / MADR-lite):

```markdown
# NNNN: <decision title>

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

- **<option A>**: why rejected
- **<option B>**: why rejected
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
- [ ] **OpenAPI/Swagger:** EVERY new/changed/removed endpoint is in `apps/api/openapi.json` (run `pnpm -F api openapi:generate`, commit the diff; CI's `openapi:check` enforces it). Enrich its request/response schema in `apps/api/src/openapi/registry.ts`. Mandatory, not deferrable.
- [ ] **Docs:** `documents/features/` or `documents/technical/` updated; ADR added in `documents/decisions/` if a decision was made
- [ ] **Migrations:** Drizzle migration committed; rollback path noted in PR body
- [ ] **Observability:** new failure modes have logs/metrics; alerts updated if SLO-relevant
- [ ] **Manual verification:** described in the PR body: what was actually exercised in a browser / curl

---

## Useful slash commands

- `/plan`, `/write-plan`, `/execute-plan`: planning lifecycle
- `/brainstorm`: feature exploration
- `/start`: surface relevant skills at session start
- `/status`: check progress

---

## Living document

This file is **expected to evolve**. When we encounter a recurring decision,
a footgun, or a convention worth codifying, add it here in the relevant
section. Drift between code reality and CLAUDE.md is a bug: fix in the
same PR that introduced the drift.
