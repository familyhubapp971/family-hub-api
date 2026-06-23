import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, canManage, memberInTenant } from '../lib/permissions.js';
import {
  CONTINENTS,
  listExplored,
  addExplored,
  listLearnProgress,
  addLearnComplete,
} from '../lib/world-flags.js';

// World Flags progress — GET/POST /api/world-flags.
//
// Phase 2a — "explore": tracks which country flags a child has revealed on
// the flashcard.
// Phase 2b — "learn path": tracks which sets of 5 countries a child has
// mastered (100% quiz) per continent, which unlocks the next set.
//
// Auth mirrors reading-log: a child accesses only their own progress; an
// admin or adult can access any member's progress in the same tenant.
//
// Timed-quiz best scores stay client-side (localStorage) for now — no
// server endpoint, matching the legacy behaviour.

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const memberQuerySchema = z.object({ memberId: z.string().uuid() });

const exploreBodySchema = z.object({
  memberId: z.string().uuid(),
  // Country code: ISO 3166-1 alpha-2 (2 chars) or XK for Kosovo (2 chars too),
  // plus alpha-3 edge-cases (3 chars). Kept loose as 2–3 chars.
  countryCode: z.string().min(2).max(3),
});

// The six continents the World Flags dataset is grouped by (mirrors the
// CONTINENTS list in apps/web data/countries). Constrained server-side so the
// table can't accumulate arbitrary continent strings from a bad client.

const learnCompleteBodySchema = z.object({
  memberId: z.string().uuid(),
  continent: z.enum(CONTINENTS),
  // Zero-based index of the completed set of 5 countries within the continent.
  // Each continent has at most ~10 sets; cap generously to reject junk.
  chunkIndex: z.number().int().min(0).max(60),
});

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
    return c.json({ explored: await listExplored(db, tenantId, parsed.data.memberId) });
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
    await addExplored(db, tenantId, parsed.data.memberId, parsed.data.countryCode);
    return c.json({ explored: true });
  })

  // GET /learn?memberId= → { progress: Record<continent, number[]> }
  // Completed set indices per continent for the structured Learn path.
  .get('/learn', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('world-flags GET /learn reached without userRow');
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
    return c.json({ progress: await listLearnProgress(db, tenantId, parsed.data.memberId) });
  })

  // POST /learn-complete — idempotent mark-a-set-as-mastered.
  // Body: { memberId, continent, chunkIndex }
  // Returns: { completed: true }
  .post('/learn-complete', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('world-flags POST /learn-complete reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const rawBody = (await c.req.json().catch(() => null)) as unknown;
    const parsed = learnCompleteBodySchema.safeParse(rawBody);
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
    await addLearnComplete(
      db,
      tenantId,
      parsed.data.memberId,
      parsed.data.continent,
      parsed.data.chunkIndex,
    );
    return c.json({ completed: true });
  });
