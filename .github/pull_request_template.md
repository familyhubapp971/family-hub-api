<!--
PR title format:  <type>(FHS-XXX): short summary
  examples:
    feat(FHS-149): scaffold Hono API with /health and /hello
    fix(FHS-12): tenant context middleware loses ctx on async handler
    chore(FHS-144): bootstrap repo with baseline files

Branch name format:  <type>/FHS-XXX-short-slug
  examples:
    feat/FHS-149-stack-scaffolding
    fix/FHS-12-tenant-context-async
-->

## Jira

Closes [FHS-XXX](https://qualicion2.atlassian.net/browse/FHS-XXX)

## What

<!-- One-paragraph summary of the change. -->

## Why

<!-- The motivation, tied to the Jira ticket's user story or acceptance criteria. -->

## How

<!-- Bullet list of the key implementation decisions. -->

## Acceptance criteria check

<!-- Mirror the Gherkin scenarios from the Jira ticket. Tick each one. -->

- [ ] **Scenario:** ...
  - [ ] Given/When/Then validated
- [ ] **Scenario:** ...

## Test plan

- [ ] Unit tests (Vitest) added/updated
- [ ] E2E tests (Playwright) added/updated where user-facing
- [ ] `pnpm test` passes locally
- [ ] Manual verification done — describe what you exercised

## Screenshots / recordings

<!-- Required for any UI change. Drag and drop here. -->

## Risk & rollout

- [ ] Migration changes? (link migration file)
- [ ] Env var changes? (document in PR body and update Railway)
- [ ] Breaking API change? (note in CHANGELOG and notify consumers)

## Checklist

- [ ] PR title contains the FHS-XXX key
- [ ] Branch name contains the FHS-XXX key
- [ ] Docs updated (`docs/product/` or `docs/technical/` as appropriate)
- [ ] CODEOWNERS reviewers requested
