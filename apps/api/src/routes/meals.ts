import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { mealTemplates, members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-229 — GET + POST /api/meals.
//
// Backs the Meals tab on /t/:slug/dashboard. The family's repeating
// weekly meal plan is a 7-day × 4-slot grid stored in meal_templates
// (seeded empty by FHS-40). GET returns every cell the family has
// filled in; POST upserts one cell at a time. An empty `name` deletes
// the row so the UI can clear a slot without a separate endpoint.

export const dayOfWeekValues = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const mealSlotValues = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type DayOfWeek = (typeof dayOfWeekValues)[number];
export type MealSlot = (typeof mealSlotValues)[number];

export const mealCellSchema = z.object({
  id: z.string().uuid(),
  dayOfWeek: z.enum(dayOfWeekValues),
  slot: z.enum(mealSlotValues),
  name: z.string(),
});

export const listMealsResponseSchema = z.object({
  meals: z.array(mealCellSchema),
});

export type ListMealsResponse = z.infer<typeof listMealsResponseSchema>;

// `name` is trimmed before write; empty/whitespace = delete.
const upsertMealRequestSchema = z.object({
  dayOfWeek: z.enum(dayOfWeekValues),
  slot: z.enum(mealSlotValues),
  name: z.string().max(120, 'meal name must be at most 120 characters'),
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

    const trimmed = parsed.data.name.trim();

    if (trimmed === '') {
      // Empty name = delete the cell. Idempotent — a delete on an empty
      // slot is a no-op (returns 0 rows).
      await db
        .delete(mealTemplates)
        .where(
          and(
            eq(mealTemplates.tenantId, tenantId),
            eq(mealTemplates.dayOfWeek, parsed.data.dayOfWeek),
            eq(mealTemplates.slot, parsed.data.slot),
          ),
        );
      return c.json({ deleted: true }, 200);
    }

    // Upsert via the (tenant_id, day_of_week, slot) unique index.
    const [row] = await db
      .insert(mealTemplates)
      .values({
        tenantId,
        dayOfWeek: parsed.data.dayOfWeek,
        slot: parsed.data.slot,
        name: trimmed,
      })
      .onConflictDoUpdate({
        target: [mealTemplates.tenantId, mealTemplates.dayOfWeek, mealTemplates.slot],
        set: { name: trimmed, updatedAt: new Date() },
      })
      .returning({
        id: mealTemplates.id,
        dayOfWeek: mealTemplates.dayOfWeek,
        slot: mealTemplates.slot,
        name: mealTemplates.name,
      });

    if (!row) throw new Error('upsert returned no row');

    return c.json(
      mealCellSchema.parse({
        id: row.id,
        dayOfWeek: row.dayOfWeek as DayOfWeek,
        slot: row.slot as MealSlot,
        name: row.name ?? '',
      }),
      200,
    );
  });
