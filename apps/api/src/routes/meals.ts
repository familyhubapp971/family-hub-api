import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { mealTemplates, members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-229 — GET + POST /api/meals. Expanded in FHS-264.
//
// Backs the Meals tab on /t/:slug/dashboard. The family's repeating
// weekly meal plan lives in meal_templates (seeded empty by FHS-40).
// GET returns every planned meal; POST upserts one at a time. An empty
// `name` deletes the row so the UI can clear a slot without a separate
// endpoint.
//
// FHS-264: each meal carries `memberId` (null = whole family) and a
// `recurring` flag. A (day, slot) can hold one whole-family meal plus
// one per member, so the upsert keys on memberId too (two partial unique
// indexes back this — see schema.ts).

export const dayOfWeekValues = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const mealSlotValues = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type DayOfWeek = (typeof dayOfWeekValues)[number];
export type MealSlot = (typeof mealSlotValues)[number];

export const mealCellSchema = z.object({
  id: z.string().uuid(),
  dayOfWeek: z.enum(dayOfWeekValues),
  slot: z.enum(mealSlotValues),
  name: z.string(),
  // FHS-264 — null = whole family; otherwise the member it's planned for.
  memberId: z.string().uuid().nullable(),
  recurring: z.boolean(),
});

export const listMealsResponseSchema = z.object({
  meals: z.array(mealCellSchema),
});

export type ListMealsResponse = z.infer<typeof listMealsResponseSchema>;

// `name` is trimmed before write; empty/whitespace = delete. `memberId`
// and `recurring` default to whole-family + non-recurring when omitted.
const upsertMealRequestSchema = z.object({
  dayOfWeek: z.enum(dayOfWeekValues),
  slot: z.enum(mealSlotValues),
  name: z.string().max(120, 'meal name must be at most 120 characters'),
  memberId: z.string().uuid().nullable().default(null),
  recurring: z.boolean().default(false),
});

const WRITE_ROLES = new Set(['admin', 'adult']);

async function loadCallerMember(
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

export const mealsRouter = new Hono()
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('meals handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }

    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }

    const rows = await db
      .select({
        id: mealTemplates.id,
        dayOfWeek: mealTemplates.dayOfWeek,
        slot: mealTemplates.slot,
        name: mealTemplates.name,
        memberId: mealTemplates.memberId,
        recurring: mealTemplates.recurring,
      })
      .from(mealTemplates)
      .where(eq(mealTemplates.tenantId, tenantId))
      .orderBy(asc(mealTemplates.dayOfWeek), asc(mealTemplates.slot));

    const response: ListMealsResponse = {
      meals: rows.map((r) => ({
        id: r.id,
        dayOfWeek: r.dayOfWeek as DayOfWeek,
        slot: r.slot as MealSlot,
        name: r.name ?? '',
        memberId: r.memberId ?? null,
        recurring: r.recurring,
      })),
    };
    return c.json(listMealsResponseSchema.parse(response));
  })
  .post('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('meals handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }

    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!WRITE_ROLES.has(caller.role)) {
      return c.json(
        { error: 'forbidden', detail: 'only admins and adults can edit the meal plan' },
        403,
      );
    }

    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = upsertMealRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        400,
      );
    }

    const { dayOfWeek, slot, memberId, recurring } = parsed.data;
    const trimmed = parsed.data.name.trim();

    // Multi-tenancy: a meal may only be assigned to a member of THIS
    // tenant. Reject a cross-tenant (or unknown) memberId before any write.
    if (memberId !== null) {
      const owner = await db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.id, memberId), eq(members.tenantId, tenantId)))
        .limit(1);
      if (!owner[0]) {
        return c.json({ error: 'invalid request', detail: 'member not found in this tenant' }, 400);
      }
    }

    // The (day, slot, member) the write targets. memberId null → the
    // whole-family row; otherwise the specific member's row.
    const memberMatch =
      memberId === null ? isNull(mealTemplates.memberId) : eq(mealTemplates.memberId, memberId);

    if (trimmed === '') {
      // Empty name = delete that specific meal. Idempotent — a delete on
      // an empty slot is a no-op (returns 0 rows).
      await db
        .delete(mealTemplates)
        .where(
          and(
            eq(mealTemplates.tenantId, tenantId),
            eq(mealTemplates.dayOfWeek, dayOfWeek),
            eq(mealTemplates.slot, slot),
            memberMatch,
          ),
        );
      return c.json({ deleted: true }, 200);
    }

    // Upsert. The conflict target depends on whether this is the
    // whole-family row (everyone partial index) or a per-member row
    // (member partial index) — see the two partial unique indexes.
    const insert = db.insert(mealTemplates).values({
      tenantId,
      dayOfWeek,
      slot,
      name: trimmed,
      memberId,
      recurring,
    });
    const set = { name: trimmed, recurring, updatedAt: new Date() };
    const upsert =
      memberId === null
        ? insert.onConflictDoUpdate({
            target: [mealTemplates.tenantId, mealTemplates.dayOfWeek, mealTemplates.slot],
            targetWhere: sql`${mealTemplates.memberId} is null`,
            set,
          })
        : insert.onConflictDoUpdate({
            target: [
              mealTemplates.tenantId,
              mealTemplates.dayOfWeek,
              mealTemplates.slot,
              mealTemplates.memberId,
            ],
            targetWhere: sql`${mealTemplates.memberId} is not null`,
            set,
          });

    const [row] = await upsert.returning({
      id: mealTemplates.id,
      dayOfWeek: mealTemplates.dayOfWeek,
      slot: mealTemplates.slot,
      name: mealTemplates.name,
      memberId: mealTemplates.memberId,
      recurring: mealTemplates.recurring,
    });

    if (!row) throw new Error('upsert returned no row');

    return c.json(
      mealCellSchema.parse({
        id: row.id,
        dayOfWeek: row.dayOfWeek as DayOfWeek,
        slot: row.slot as MealSlot,
        name: row.name ?? '',
        memberId: row.memberId ?? null,
        recurring: row.recurring,
      }),
      200,
    );
  });
