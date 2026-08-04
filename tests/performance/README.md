# Performance tests (k6)

## What this tests, and why it changed (FHS-460)

Before FHS-460, every scenario here (`smoke`/`load`/`stress`/`soak`) only
ever called `GET /health` and `GET /hello`: two endpoints nobody's phone
ever touches. That told us the server process is alive. It told us
**nothing** about whether a real family's dashboard, calendar, or a kid's
ChildWorld screen stays fast when 50+ people are using the app at once.

The suite now drives **real, authenticated family sessions**:

- **Kid session** (`lib/helpers.js` `kidSession`): logs in with a PIN
  (the same flow a kid uses on a shared family tablet) and hits every
  screen the kid ChildWorld dashboard loads on open: profile, Today,
  tasks, calendar, meals, habits, weeks, savings, investments, rewards,
  learn. 12 requests.
- **Parent session** (`parentSession`): logs in with a real Supabase
  password (the same flow a parent uses) and hits the parent Today
  dashboard, family members, calendar, tasks, meals, and one kid's habit
  grid. 7 requests.

A full kid+parent session is **12–19 requests**, matching what a real
person actually does when they open the app, not two endpoints in a
vacuum.

## Quick start (run from this folder)

This folder is self-contained: `cd tests/performance` and use its own
commands (k6 must be installed: `brew install k6`):

```bash
cd tests/performance

pnpm seed                 # create throwaway loadtest- tenants + fixtures (needs DATABASE_URL)
pnpm smoke                # 1 VU, 30s: quick sanity (runs in CI)
pnpm load                 # 50 VUs, 5m: steady expected load
pnpm stress               # 200 VUs, 10m: past peak
pnpm soak                 # 30 VUs, 2h: leak/drift detection
pnpm smoke:auth           # auth-only smoke

pnpm report               # open the latest run's HTML dashboard in your browser

# point at staging + a seeded fixtures file:
BASE_URL=$STAGING_API_URL pnpm smoke -- -e LOAD_FIXTURES=fixtures/load-tenants.json
```

(The same scenarios are also exposed from the repo root as
`pnpm perf:smoke` / `perf:load` / …, either entry point works.)

> ⚠️ Before `load`/`stress`/`soak` against staging: the API rate-limits
> **100 requests/min per IP**, so a single-machine run measures 429
> rejections unless `RATE_LIMIT_PER_MINUTE` is raised on staging for the
> window. See `config.js`. **Only GET-load `loadtest-` synthetic tenants,
> never write against real family slugs.**

## 1. Seed synthetic tenants first

The sessions above need real data to read (an empty family makes every
screen return an empty list, which hides real-world latency). Seed
throwaway tenants before running anything beyond `smoke`'s built-in
fallback:

```bash
node tests/performance/bin/seed-load-tenants.mjs            # 3 tenants (default)
node tests/performance/bin/seed-load-tenants.mjs 10         # 10 tenants
node tests/performance/bin/seed-load-tenants.mjs 5 tests/performance/fixtures/my-run.json
```

This connects to `DATABASE_URL` (from `.env.local` or your shell) as the
**database owner** (bypasses row-level security, same as the integration
test seeder) and, for each tenant, creates:

- 1 admin parent member (no login yet, see "Parent accounts" below)
- 2 kid members, PIN `1234` for both (bcrypt-hashed, same cost the api uses)
- ~40 calendar events spread across the surrounding weeks
- ~25 tasks (some done, some open, various due dates)
- ~16 habits (8 per kid) + ~60 sticker placements on the current week
- a handful of planned meals
- a family savings goal + a per-kid banked-stickers balance

It writes a **fixtures JSON** (default
`tests/performance/fixtures/load-tenants.json`, gitignored; it's tied to
one throwaway seed run's database IDs, not something to commit) that the
k6 scenarios read via `-e LOAD_FIXTURES=<path>`.

### ⚠️ Check which database you're about to write to

This repo's local `.env.local` `DATABASE_URL` may already point at a
**shared Supabase Postgres project** (staging), not a local database:
check `echo $DATABASE_URL` (or the value in `.env.local`) before running
the seed script. Seeding writes real rows to whatever `DATABASE_URL`
resolves to. If you want a local-only seed, point `DATABASE_URL` at your
local dev Postgres (`docker compose up -d`, then
`DATABASE_URL=postgres://familyhub:familyhub@localhost:5432/familyhub_dev`)
before running the script.

### Purge seeded tenants when done

Every seeded tenant's slug is prefixed `loadtest-<runId>-`, printed at
the end of the seed run. Delete a whole run (cascades to every table via
FK `ON DELETE CASCADE`):

```sql
DELETE FROM tenants WHERE slug LIKE 'loadtest-<runId>-%';
-- or, to purge every load-test tenant ever seeded:
DELETE FROM tenants WHERE slug LIKE 'loadtest-%';
```

### Parent accounts (manual step)

The seed script **cannot** create Supabase Auth users: that needs the
Supabase Admin API / dashboard, not a database connection, and this
script deliberately carries no Supabase credentials. So parent sessions
are opt-in:

1. In the **same Supabase project** the target api points at (staging),
   create a user with the email from `fixtures[].parent.email`.
2. Edit `fixtures[].parent.password` in the fixtures JSON to the password
   you set (it starts as `null`, which fails loudly instead of silently
   if you forget this step and try to run parent sessions anyway).
3. Link the new Supabase user to the seeded admin member row:

   ```sql
   UPDATE members SET user_id = '<supabase-user-uuid>'
     WHERE id = '<fixtures[].parent.adminMemberId>';
   ```

Without this, scenarios still run: they just run **kid sessions only**
(the loader warns once per run and skips `parentSession`).

## 2. Run a scenario

```bash
# Local api (pnpm dev, port 3001), with seeded fixtures:
k6 run -e LOAD_FIXTURES=tests/performance/fixtures/load-tenants.json \
       tests/performance/scenarios/smoke.js

# Against staging, with Supabase creds so parent sessions run too:
k6 run -e BASE_URL="$STAGING_API_URL" \
       -e LOAD_FIXTURES=tests/performance/fixtures/load-tenants.json \
       -e SUPABASE_URL="$SUPABASE_URL_STAGING" \
       -e SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY_STAGING" \
       tests/performance/scenarios/load.js

# No fixtures at all: falls back to a health-only ping (NOT a real test,
# it warns loudly and just proves the runner + api are wired up):
k6 run tests/performance/scenarios/smoke.js
```

Or via the pnpm scripts (which wrap `run-k6.sh` for consistent report
paths, pass `-e` flags through as extra args):

```bash
pnpm perf:smoke -- -e LOAD_FIXTURES=tests/performance/fixtures/load-tenants.json
pnpm perf:load  -- -e LOAD_FIXTURES=tests/performance/fixtures/load-tenants.json
pnpm perf:stress -- -e LOAD_FIXTURES=tests/performance/fixtures/load-tenants.json
pnpm perf:soak  -- -e LOAD_FIXTURES=tests/performance/fixtures/load-tenants.json
```

k6 itself is **not installed by default** on most dev machines:
`bin/run-k6.sh` prints an install hint (`brew install k6` on macOS) if
it's missing from `PATH`.

## 3. The rate-limit trap: read before running load/stress/soak

`apps/api/src/middleware/rate-limit.ts` caps every caller at
`RATE_LIMIT_PER_MINUTE` (default: 100) requests per 60 seconds, keyed on
the **caller's IP**. k6 sends all of a run's traffic from one machine, so
every VU shares **one** bucket, no matter how many VUs you configure.

A full session is ~12–19 requests. At the `load` profile (50 VUs) that's
up to 950 requests in the first minute: you'll exhaust the 100-token
bucket in seconds and spend the rest of the run measuring `429`
responses, not real API latency. Before running `load`/`stress`/`soak`
against staging:

1. Ask for `RATE_LIMIT_PER_MINUTE` to be raised on the staging Railway
   service for the test window (and set back after), **or**
2. Keep VUs low enough that `VUs × ~19 requests` stays under the limit,
   fine for `smoke` (1 VU), but defeats the point of `load`/`stress`.

A run that's mostly `429`s is a rate-limit ceiling finding, not a real
capacity finding. Don't report it as one.

## Safety rules: non-negotiable

- **GET-only.** These scenarios never POST/PUT/PATCH/DELETE against a
  real endpoint that mutates data. Kid and parent sessions are read-only
  by design (see `lib/helpers.js`); keep it that way. Login calls
  (`POST /api/auth/kid-pin`, the Supabase password grant) are the only
  writes-adjacent calls, and neither mutates family data.
- **Only run against `loadtest-` synthetic tenants.** Every fixture the
  seed script produces uses a `loadtest-<runId>-N` slug. Never point
  `LOAD_FIXTURES` at a file containing a real family's `tenantSlug` /
  `memberId` / PIN.
- **Never run write-capable load against real family slugs.** If this
  suite ever grows write scenarios (create task, tick habit, etc.), gate
  them the same way: `loadtest-` tenants only, never production families.

## Hot-screen thresholds

`config.js` tags the two screens every real session opens,
`GET /api/dashboard/today` (parent) and `GET /api/kid/today` (kid), with
`name:dashboard` / `name:kid-today` and gives each its own p95 budget
(`hotScreenThresholds()`), separate from the global average. If those two
screens regress, the run fails even if the overall p95 still looks fine.

## Files

```text
tests/performance/
  config.js                        # BASE_URL, VU profiles, thresholds, rate-limit warning
  scenarios/
    smoke.js / load.js / stress.js / soak.js   # authenticated-session scenarios
    auth-smoke.js                  # standalone GET /api/me baseline (unchanged by FHS-460)
  lib/                             # k6 VU-runtime modules the scenarios import
    auth.js                        # kidLogin() / parentLogin()
    fixtures.js                    # reads LOAD_FIXTURES + logs everyone in once (setup())
    helpers.js                     # kidSession() / parentSession() / mondayOf() / apiGet()
    report.js                      # handleSummary: writes JSON reports
  bin/                             # runnable tools (invoked by the pnpm scripts / CI)
    run-k6.sh                      # wrapper: install hint + report path + HTML dashboard export
    open-report.sh                 # opens the latest HTML report (pnpm report)
    seed-load-tenants.mjs          # provisions synthetic loadtest- tenants + writes fixtures
  fixtures/                        # gitignored: generated by seed-load-tenants.mjs
  reports/                         # gitignored: generated by handleSummary
```
