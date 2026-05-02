/**
 * Local development seed.
 *
 * Inserts the "default" tenant (FHS-2) plus a small fixture of
 * additional family rows for poking at the dev stack. Idempotent —
 * every insert uses ON CONFLICT DO NOTHING on the slug unique key, so
 * re-runs are safe.
 *
 * Sprint 1 will extend this with `family_members` rows once that table
 * lands (FHS-1 epic, ADR 0009). For now: tenants only.
 *
 * Idempotency contract: every operation MUST be safe to re-run. Use
 * `INSERT ... ON CONFLICT DO NOTHING` with deterministic primary keys
 * or unique constraints. Don't generate fresh UUIDs each run.
 */

import { closeDb, getDb } from './client.js';
import { SEED_DEFAULT_TENANT_ID, tenants, type NewTenant } from './schema.js';
import { createLogger } from '../logger.js';

const log = createLogger('seed');

// Deterministic seed rows. Slugs follow the `<slug>.familyhub.app`
// subdomain pattern from ADR 0002. The "default" tenant uses the
// frozen UUID exported from schema.ts so tests + downstream seeds can
// reference it without lookups.
const SEED_TENANTS: NewTenant[] = [
  {
    id: SEED_DEFAULT_TENANT_ID,
    slug: 'default',
    name: 'Default Family',
    timezone: 'UTC',
    currency: 'USD',
  },
  // Additional fixture families — swap in ones that match local dev needs.
  { slug: 'kingdom', name: 'The Kingdom Family', timezone: 'Asia/Dubai', currency: 'AED' },
  { slug: 'lighthouse', name: 'Lighthouse Family', timezone: 'America/New_York', currency: 'USD' },
  { slug: 'compass', name: 'Compass Family', timezone: 'Europe/London', currency: 'GBP' },
];

async function main() {
  const db = getDb();
  let inserted = 0;

  for (const t of SEED_TENANTS) {
    const result = await db
      .insert(tenants)
      .values(t)
      .onConflictDoNothing({ target: tenants.slug })
      .returning();
    if (result.length > 0) inserted += 1;
  }

  log.info(
    { totalSeed: SEED_TENANTS.length, inserted, skipped: SEED_TENANTS.length - inserted },
    'seed: tenants',
  );
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    log.error({ err }, 'seed failed');
    await closeDb();
    process.exit(1);
  });
