/**
 * Local development seed.
 *
 * Goal (per FHS-168): three fake tenants, each with one admin and one
 * member user, idempotent across re-runs. Useful for poking the dev
 * stack without manually creating accounts every time the volume gets
 * cleared.
 *
 * Current state: the Drizzle schema is intentionally empty until
 * Sprint 1 (ADR 0001 — tenants and users land with tenant_id + RLS).
 * The seed runs as a no-op until then. Once `tenants` and `users`
 * exist, replace the SEED constant below with the real inserts and
 * uncomment the active block.
 *
 * Idempotency contract: every operation MUST be safe to re-run. Use
 * `INSERT ... ON CONFLICT DO NOTHING` (or Drizzle's `onConflictDoNothing()`)
 * with deterministic primary keys / unique constraints. Don't generate
 * fresh UUIDs each run.
 */

import { sql } from 'drizzle-orm';
import { closeDb, getDb } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('seed');

// Deterministic IDs so re-runs upsert the same rows. Slugs follow the
// `<slug>.familyhub.app` subdomain pattern from ADR 0002.
const SEED = [
  { slug: 'kingdom', name: 'The Kingdom Family', admin: 'admin@kingdom.test', member: 'member@kingdom.test' },
  { slug: 'lighthouse', name: 'Lighthouse Family', admin: 'admin@lighthouse.test', member: 'member@lighthouse.test' },
  { slug: 'compass', name: 'Compass Family', admin: 'admin@compass.test', member: 'member@compass.test' },
];

async function tableExists(db: ReturnType<typeof getDb>, name: string): Promise<boolean> {
  // PostgreSQL system catalogue — single round-trip, no schema dep.
  const { rows } = await db.execute<{ exists: boolean }>(
    sql`SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}
    ) AS exists`,
  );
  return Boolean(rows[0]?.exists);
}

async function main() {
  const db = getDb();

  const hasTenants = await tableExists(db, 'tenants');
  const hasUsers = await tableExists(db, 'users');

  if (!hasTenants || !hasUsers) {
    log.warn(
      { hasTenants, hasUsers, expected: ['tenants', 'users'] },
      'seed: schema not ready — skipping. tenants/users land in Sprint 1 per ADR 0001. Re-run after the schema migration.',
    );
    return;
  }

  // Replace this block when tenants/users exist:
  // for (const t of SEED) {
  //   const [tenant] = await db.insert(tenants).values({ slug: t.slug, name: t.name })
  //     .onConflictDoNothing({ target: tenants.slug }).returning();
  //   await db.insert(users).values([
  //     { tenantId: tenant.id, email: t.admin, role: 'admin' },
  //     { tenantId: tenant.id, email: t.member, role: 'member' },
  //   ]).onConflictDoNothing({ target: [users.tenantId, users.email] });
  // }

  log.info({ tenants: SEED.length }, 'seed: schema ready — implement inserts (see SEED constant)');
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    log.error({ err }, 'seed failed');
    await closeDb();
    process.exit(1);
  });
