# `.claude/` — project-scoped Claude Code config

This directory is **committed** so anyone cloning the repo gets the
same Claude Code experience as the original maintainers. It contains:

| File / dir | Purpose |
| --- | --- |
| [`settings.json`](settings.json) | Permission allowlist (safe Bash commands, web-fetch domains, read paths) + denylist for destructive ops. Loaded by Claude Code on session start. |
| [`agents/`](agents/) | Curated specialist subagent definitions for SaaS work: API design, backend, frontend, fullstack, TypeScript, deployment, DevOps, code review, test automation, security, QA, docs, product, multi-agent coordination. |
| [`skills/`](skills/) | Curated skills for the development workflow: brainstorming, writing/executing plans, TDD, systematic debugging, verification before completion, git worktrees, finishing branches, requesting code review, "using superpowers" (skill discovery). |

## How it interacts with global config

Claude Code merges this project-scoped `.claude/` with your **global**
`~/.claude/`. If a skill or agent exists in both, the **project copy
wins** — useful when the project needs a tweaked variant.

You can keep using everything in your global `~/.claude/` (subagents,
slash commands, MCP servers) — the project-scoped folder doesn't
shadow them, only adds / overrides specific entries.

## Settings policy

`settings.json` is intentionally **conservative**:

- **Allowed Bash:** read-only git commands, pnpm scripts, npx tools
  the project uses (Playwright, BDD, Vitest, Drizzle), Docker
  inspection, network diagnostics (dig, openssl), gh read-only.
- **Allowed WebFetch:** project doc domains (Hono, Drizzle, Supabase,
  Stripe), GitHub, npmjs, the Jira site.
- **Denied Bash:** `git push --force`, `git reset --hard`, `git clean
  -f`, `rm -rf /`, `npm/pnpm publish` — destructive or
  externally-visible operations stay manual.

If you need to add a permission, edit `settings.json` and commit the
change with rationale in the PR. **Don't add `settings.local.json`
to git** — it's gitignored for personal overrides only.

## Curated agents — what to use when

Reference [`/CLAUDE.md` Skill routing](../CLAUDE.md#skill-routing--when-to-use-what)
for full guidance. Quick map:

| Work | Agent |
| --- | --- |
| New API endpoint | `api-designer`, `backend-developer` |
| New web feature | `frontend-developer`, `fullstack-developer` |
| Type-system / TS strictness work | `typescript-pro` |
| Railway / Docker / CI | `deployment-engineer`, `devops-engineer` |
| Pre-merge review | `code-reviewer` |
| Test scaffolding / coverage | `test-automator`, `qa-expert` |
| Security audit / threat model | `security-auditor` |
| Doc system / README rewrites | `documentation-engineer` |
| Feature scoping / requirements | `product-manager` |
| Multi-agent task orchestration | `multi-agent-coordinator` |

## Curated skills — what to use when

| Work | Skill |
| --- | --- |
| Surface relevant skills at session start | `using-superpowers` |
| Explore feature design before code | `brainstorming` |
| Multi-step task with spec | `writing-plans` → `executing-plans` |
| Any feature or bugfix | `test-driven-development` |
| Bug or unexpected behaviour | `systematic-debugging` |
| Isolated branch work | `using-git-worktrees` |
| Wrapping up a feature | `finishing-a-development-branch` |
| Pre-merge verification | `verification-before-completion` |
| Requesting code review | `requesting-code-review` |
