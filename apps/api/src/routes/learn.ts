import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { learnProgress, members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-270 — GET /api/learn, PATCH /api/learn/:subject.
//
// Backs the ChildWorld Learn cards: a fixed set of subjects each with a
// 0–100 progress bar. The actual learning content is a separate epic;
// this just persists progress so the cards aren't empty. Parent-accessed
// (standard auth); memberId is passed + validated.

// The fixed subject catalogue (matches the Learn card UI).
export const LEARN_SUBJECTS = [
  'Maths',
  'Reading',
  'World Flags',
  'Logic',
  'Science',
  'Creative',
] as const;

export const learnSubjectSchema = z.object({
  subject: z.string(),
  progress: z.number().int().min(0).max(100),
});

export const listLearnResponseSchema = z.object({
  subjects: z.array(learnSubjectSchema),
});

const memberQuerySchema = z.object({ memberId: z.string().uuid() });
const patchRequestSchema = z.object({
  memberId: z.string().uuid(),
  progress: z.number().int().min(0).max(100),
});

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

// A caller may read/write a member's learn progress only if they ARE that
// member or are a parent (admin/adult) — same access model as the journal.
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

export const learnRouter = new Hono()
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('learn handler reached without userRow');
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
      .select({ subject: learnProgress.subject, progress: learnProgress.progress })
      .from(learnProgress)
      .where(
        and(eq(learnProgress.tenantId, tenantId), eq(learnProgress.memberId, parsed.data.memberId)),
      );
    const stored = new Map(rows.map((r) => [r.subject, r.progress]));
    // Always return the full fixed catalogue, defaulting unseen subjects
    // to 0 — the UI renders one card per subject regardless.
    const subjects = LEARN_SUBJECTS.map((subject) => ({
      subject,
      progress: stored.get(subject) ?? 0,
    }));
    return c.json(listLearnResponseSchema.parse({ subjects }));
  })
  .patch('/:subject', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('learn handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const subject = decodeURIComponent(c.req.param('subject'));
    if (!(LEARN_SUBJECTS as readonly string[]).includes(subject)) {
      return c.json(
        { error: 'unknown subject', detail: 'subject not in the Learn catalogue' },
        400,
      );
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = patchRequestSchema.safeParse(body);
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
    await db
      .insert(learnProgress)
      .values({
        tenantId,
        memberId: parsed.data.memberId,
        subject,
        progress: parsed.data.progress,
      })
      .onConflictDoUpdate({
        target: [learnProgress.tenantId, learnProgress.memberId, learnProgress.subject],
        set: { progress: parsed.data.progress, updatedAt: sql`now()` },
      });
    return c.json({ subject, progress: parsed.data.progress });
  });
