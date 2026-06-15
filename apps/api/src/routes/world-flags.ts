import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { worldFlagsProgress, members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// Learn Phase 2a — GET/POST /api/world-flags.
//
// Tracks which country flags a child has "explored" (tapped to reveal name
// on the flashcard). Auth mirrors reading-log: a child accesses only their
// own progress; an admin or adult can access any member's progress in the
// same tenant.
//
// TODO (later PRs): add quiz-score endpoints when timed quizzes land.
// TODO (later PRs): add structured-learn-path chunk endpoints.
// TODO (later PRs): add Leaflet map endpoints when interactive maps land.

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const memberQuerySchema = z.object({ memberId: z.string().uuid() });

const exploreBodySchema = z.object({
  memberId: z.string().uuid(),
  // Country code: ISO 3166-1 alpha-2 (2 chars) or XK for Kosovo (2 chars too),
  // plus alpha-3 edge-cases (3 chars). Kept loose as 2–3 chars.
  countryCode: z.string().min(2).max(3),
});

// ─── Auth helpers (same pattern as reading-log) ───────────────────────────────

async function loadCaller(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  userId: string,
): Promise<{ id: string; role: string } | null> {
  const rows = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

function canManage(caller: { id: string; role: string }, memberId: string): boolean {
  return caller.id === memberId || caller.role === 'admin' || caller.role === 'adult';
}

async function memberInTenant(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  memberId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.id, memberId)))
    .limit(1);
  return rows.length > 0;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const worldFlagsRouter = new Hono()

  // GET /?memberId= → { explored: string[] }
  // Returns all country codes this member has explored, in no guaranteed order.
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('world-flags GET handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const parsed = memberQuerySchema.safeParse({ memberId: c.req.query('memberId') });
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const db = getDb();
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!(await memberInTenant(db, tenantId, parsed.data.memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!canManage(caller, parsed.data.memberId)) {
      return c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403);
    }
    const rows = await db
      .select({ countryCode: worldFlagsProgress.countryCode })
      .from(worldFlagsProgress)
      .where(
        and(
          eq(worldFlagsProgress.tenantId, tenantId),
          eq(worldFlagsProgress.memberId, parsed.data.memberId),
        ),
      );
    return c.json({ explored: rows.map((r) => r.countryCode) });
  })

  // POST /explore — idempotent mark-as-explored.
  // Body: { memberId, countryCode }
  // Returns: { explored: true }
  .post('/explore', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('world-flags POST handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const rawBody = (await c.req.json().catch(() => null)) as unknown;
    const parsed = exploreBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const db = getDb();
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!(await memberInTenant(db, tenantId, parsed.data.memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!canManage(caller, parsed.data.memberId)) {
      return c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403);
    }
    // Idempotent: onConflictDoNothing targets the unique (tenant,member,code) index.
    await db
      .insert(worldFlagsProgress)
      .values({
        tenantId,
        memberId: parsed.data.memberId,
        countryCode: parsed.data.countryCode,
      })
      .onConflictDoNothing();
    return c.json({ explored: true });
  });
