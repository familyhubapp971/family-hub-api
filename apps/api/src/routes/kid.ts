import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, asc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { kidAuthMiddleware, requireKidAuth, getKidAuth } from '../middleware/kid-auth.js';
import { getDb, pinRequestTenant } from '../db/client.js';
import {
  events,
  habits,
  habitStickers,
  mealTemplates,
  members,
  mwWeeks,
  rewards,
} from '../db/schema.js';
import {
  getOrCreateCurrentWeek,
  getSavings,
  getTenantCurrency,
  listInvestments,
  mondayOf,
  redeemReward,
  stickerBalance,
  stickerDayRelation,
} from '../lib/myworld.js';
import { listHabitsResponseSchema, weekItemSchema } from './habits.js';
import { listMealsResponseSchema } from './meals.js';
import { listEventsResponseSchema } from './events.js';
import { listRewardsResponseSchema } from './rewards.js';
import { listTenantNotices, listNoticesResponseSchema } from './notices.js';
import { listTasksForMember, setTaskDoneForMember, taskItemSchema } from './tasks.js';

const STICKER_TYPES = ['gold-star', 'heart', 'magic', 'trophy'] as const;
export const kidPlaceStickerSchema = z.object({
  weekId: z.string().uuid(),
  day: z.number().int().min(0).max(6),
  sticker: z.enum(STICKER_TYPES),
});
export const kidRemoveStickerSchema = z.object({
  weekId: z.string().uuid(),
  day: z.number().int().min(0).max(6),
});
export const kidWeeksResponseSchema = z.object({ weeks: z.array(weekItemSchema) });

// FHS-364 — rewards redeem + money cards.
export const kidRedeemResponseSchema = z.object({
  stickerBalance: z.number().int(),
  redemptionId: z.string().uuid(),
});
export const kidInvestmentSchema = z.object({
  id: z.string().uuid(),
  habitId: z.string().uuid(),
  habitName: z.string().nullable(),
  habitIcon: z.string().nullable(),
  investedStickers: z.number().int(),
  originalInvestedStickers: z.number().int(),
  currentValue: z.number(),
  currentValueStickers: z.number().int(),
  daysCompleted: z.number().int(),
  daysMissed: z.number().int(),
});
export const kidFinancialResponseSchema = z.object({
  savedStickers: z.number().int(),
  savedCash: z.number(),
  currency: z.string(),
  investments: z.array(kidInvestmentSchema),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const kidTasksResponseSchema = z.object({ tasks: z.array(taskItemSchema) });
const kidTaskPatchSchema = z.object({ done: z.boolean() });

export const kidTodayResponseSchema = z.object({
  habits: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      icon: z.string().nullable(),
      color: z.string(),
    }),
  ),
});

// FHS-257 / FHS-355 — kid-scoped API surface.
//
// Mounted at /api/kid behind [kidAuthMiddleware, requireKidAuth] so every
// handler here can rely on a verified kid principal via getKidAuth(c). The
// parent Supabase auth middleware skips /api/kid (it's listed in that
// middleware's public prefixes), so a kid token never has to survive the ES256
// path. Every read is scoped to the kid's OWN tenant/member from the verified
// token — never a slug/header — so a kid can only ever see their own family.

export const kidMeResponseSchema = z.object({
  memberId: z.string().uuid(),
  tenantId: z.string().uuid(),
  tenantSlug: z.string().min(1),
});

// FHS-362 — the kid's own profile for the dashboard header: name, avatar, and
// banked stars/cash. DB-backed (members + savings), scoped to the kid's own
// member from the verified token.
export const kidProfileResponseSchema = z.object({
  displayName: z.string(),
  avatarEmoji: z.string().nullable(),
  savedStickers: z.number(),
  savedCash: z.number(),
  currency: z.string(),
});

// FHS-363 — a kid is never an admin, so they may only sticker TODAY in the
// open week. Mirrors the parent past-day gate (FHS-335) but stricter: past,
// future, and finalized weeks are all blocked. Returns a response to send, or
// null when the day is editable.
async function kidStickerDayBlocked(
  c: Context,
  db: ReturnType<typeof getDb>,
  kid: { tenantId: string; memberId: string },
  weekId: string,
  day: number,
): Promise<Response | null> {
  const rows = await db
    .select({ startDate: mwWeeks.startDate, isFinalized: mwWeeks.isFinalized })
    .from(mwWeeks)
    .where(
      and(
        eq(mwWeeks.tenantId, kid.tenantId),
        eq(mwWeeks.memberId, kid.memberId),
        eq(mwWeeks.id, weekId),
      ),
    )
    .limit(1);
  const week = rows[0];
  if (!week) return c.json({ error: 'not found', detail: 'week not found for this kid' }, 404);
  if (week.isFinalized || stickerDayRelation(week.startDate, day) !== 'today') {
    return c.json(
      { error: 'forbidden', errorCode: 'KID_TODAY_ONLY', detail: 'you can only sticker today' },
      403,
    );
  }
  return null;
}

export const kidRouter = new Hono()
  .use('*', kidAuthMiddleware())
  .use('*', requireKidAuth)
  .get('/me', (c) => {
    // No DB — just echoes the verified token claims, so no tenant pin here.
    const kid = getKidAuth(c);
    return c.json(kidMeResponseSchema.parse(kid));
  })
  // FHS-362 — the kid's own profile for the dashboard header (name + avatar +
  // banked stars/cash), scoped to the kid's own member from the token.
  .get('/profile', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const db = getDb();
    const [m] = await db
      .select({ displayName: members.displayName, avatarEmoji: members.avatarEmoji })
      .from(members)
      .where(and(eq(members.tenantId, kid.tenantId), eq(members.id, kid.memberId)))
      .limit(1);
    if (!m) {
      return c.json({ error: 'not found', detail: 'no such member for this kid' }, 404);
    }
    const [savings, currency] = await Promise.all([
      getSavings(db, kid.tenantId, kid.memberId),
      getTenantCurrency(db, kid.tenantId),
    ]);
    return c.json(
      kidProfileResponseSchema.parse({
        displayName: m.displayName,
        avatarEmoji: m.avatarEmoji,
        savedStickers: savings.savedStickers,
        savedCash: savings.savedCash,
        currency,
      }),
    );
  })
  // FHS-355 — the family noticeboard, scoped to the kid's own tenant from the
  // verified kid token. FHS-354 — pin that tenant so the read passes RLS once
  // the app runs as app_runtime (the token, not resolveTenant, is the source).
  .get('/notices', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const notices = await listTenantNotices(getDb(), kid.tenantId);
    return c.json(listNoticesResponseSchema.parse({ notices }));
  })
  // FHS-355 — the kid's OWN tasks (member-scoped from the kid token).
  .get('/tasks', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const tasks = await listTasksForMember(getDb(), kid.tenantId, kid.memberId);
    return c.json(kidTasksResponseSchema.parse({ tasks }));
  })
  // FHS-355 — tick/untick one of the kid's OWN tasks. The member+tenant guard in
  // setTaskDoneForMember means a kid can never touch another member's task.
  .patch('/tasks/:id', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'task id must be a UUID' }, 400);
    }
    const parsed = kidTaskPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const ok = await setTaskDoneForMember(
      getDb(),
      kid.tenantId,
      kid.memberId,
      id,
      parsed.data.done,
    );
    if (!ok) {
      return c.json({ error: 'not found', detail: 'no such task for this kid' }, 404);
    }
    return c.json({ ok: true });
  })
  // FHS-355 — the kid's "Today": their own active habits (member-scoped). A
  // read-only at-a-glance list; full sticker interaction is a follow-up.
  .get('/today', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const rows = await getDb()
      .select({
        id: habits.id,
        name: habits.name,
        icon: habits.icon,
        color: habits.color,
      })
      .from(habits)
      .where(
        and(
          eq(habits.tenantId, kid.tenantId),
          eq(habits.memberId, kid.memberId),
          isNull(habits.archivedAt),
        ),
      )
      .orderBy(asc(habits.createdAt));
    return c.json(kidTodayResponseSchema.parse({ habits: rows }));
  })
  // FHS-363 — the kid's weeks (for prev/next navigation), oldest first.
  .get('/weeks', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const rows = await getDb()
      .select({
        id: mwWeeks.id,
        weekNumber: mwWeeks.weekNumber,
        year: mwWeeks.year,
        startDate: mwWeeks.startDate,
        isFinalized: mwWeeks.isFinalized,
      })
      .from(mwWeeks)
      .where(and(eq(mwWeeks.tenantId, kid.tenantId), eq(mwWeeks.memberId, kid.memberId)))
      .orderBy(asc(mwWeeks.startDate));
    return c.json(kidWeeksResponseSchema.parse({ weeks: rows }));
  })
  // FHS-363 — the kid's interactive weekly habits: their habits + this week's
  // stickers + the week + spendable balance + currency. Optional ?weekId reads
  // a past week (read-only on the client). Self-scoped from the kid token.
  .get('/habits', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const db = getDb();
    const weekIdParam = c.req.query('weekId');
    let week;
    if (weekIdParam && UUID_RE.test(weekIdParam)) {
      const rows = await db
        .select()
        .from(mwWeeks)
        .where(
          and(
            eq(mwWeeks.tenantId, kid.tenantId),
            eq(mwWeeks.memberId, kid.memberId),
            eq(mwWeeks.id, weekIdParam),
          ),
        )
        .limit(1);
      // A supplied weekId that isn't this kid's is a 404 — don't silently
      // fall back to the current week (that would mislead the nav state).
      if (!rows[0]) {
        return c.json({ error: 'not found', detail: 'week not found for this kid' }, 404);
      }
      week = rows[0];
    } else {
      week = await getOrCreateCurrentWeek(db, kid.tenantId, kid.memberId);
    }
    const [habitRows, stickerRows, balance, currency] = await Promise.all([
      db
        .select({
          id: habits.id,
          name: habits.name,
          description: habits.description,
          color: habits.color,
          icon: habits.icon,
          isBonus: habits.isBonus,
        })
        .from(habits)
        .where(
          and(
            eq(habits.tenantId, kid.tenantId),
            eq(habits.memberId, kid.memberId),
            isNull(habits.archivedAt),
          ),
        )
        .orderBy(asc(habits.createdAt)),
      db
        .select({
          habitId: habitStickers.habitId,
          day: habitStickers.day,
          sticker: habitStickers.sticker,
          stickerValue: habitStickers.stickerValue,
        })
        .from(habitStickers)
        .where(
          and(
            eq(habitStickers.tenantId, kid.tenantId),
            eq(habitStickers.memberId, kid.memberId),
            eq(habitStickers.weekId, week.id),
          ),
        ),
      stickerBalance(db, kid.tenantId, kid.memberId),
      getTenantCurrency(db, kid.tenantId),
    ]);
    return c.json(
      listHabitsResponseSchema.parse({
        habits: habitRows,
        stickers: stickerRows,
        week: {
          id: week.id,
          weekNumber: week.weekNumber,
          year: week.year,
          startDate: week.startDate,
          isFinalized: week.isFinalized,
        },
        balance,
        currency,
      }),
    );
  })
  // FHS-363 — place a typed sticker on today (only). Body: { weekId, day, sticker }.
  .post('/habits/:id/stickers', async (c) => {
    const kid = getKidAuth(c);
    const habitId = c.req.param('id');
    if (!UUID_RE.test(habitId)) {
      return c.json({ error: 'invalid id', detail: 'habit id must be a UUID' }, 400);
    }
    const parsed = kidPlaceStickerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'invalid request', detail: parsed.error.issues[0]?.message ?? 'bad body' },
        400,
      );
    }
    await pinRequestTenant(kid.tenantId);
    const db = getDb();
    const { weekId, day, sticker } = parsed.data;
    const blocked = await kidStickerDayBlocked(c, db, kid, weekId, day);
    if (blocked) return blocked;
    const habitRows = await db
      .select({ id: habits.id, isBonus: habits.isBonus })
      .from(habits)
      .where(
        and(
          eq(habits.tenantId, kid.tenantId),
          eq(habits.memberId, kid.memberId),
          eq(habits.id, habitId),
        ),
      )
      .limit(1);
    const habit = habitRows[0];
    if (!habit) return c.json({ error: 'not found', detail: 'habit not found for this kid' }, 404);
    const stickerValue = habit.isBonus ? 5 : 1;
    await db
      .insert(habitStickers)
      .values({
        tenantId: kid.tenantId,
        memberId: kid.memberId,
        habitId,
        weekId,
        day,
        sticker,
        stickerValue,
      })
      .onConflictDoUpdate({
        target: [
          habitStickers.tenantId,
          habitStickers.memberId,
          habitStickers.habitId,
          habitStickers.weekId,
          habitStickers.day,
        ],
        set: { sticker, stickerValue, updatedAt: new Date() },
      });
    return c.json({ habitId, day, sticker, stickerValue });
  })
  // FHS-363 — remove today's sticker (only). Body: { weekId, day }.
  .delete('/habits/:id/stickers', async (c) => {
    const kid = getKidAuth(c);
    const habitId = c.req.param('id');
    if (!UUID_RE.test(habitId)) {
      return c.json({ error: 'invalid id', detail: 'habit id must be a UUID' }, 400);
    }
    const parsed = kidRemoveStickerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'invalid request', detail: parsed.error.issues[0]?.message ?? 'bad body' },
        400,
      );
    }
    await pinRequestTenant(kid.tenantId);
    const db = getDb();
    const { weekId, day } = parsed.data;
    const blocked = await kidStickerDayBlocked(c, db, kid, weekId, day);
    if (blocked) return blocked;
    await db
      .delete(habitStickers)
      .where(
        and(
          eq(habitStickers.tenantId, kid.tenantId),
          eq(habitStickers.memberId, kid.memberId),
          eq(habitStickers.habitId, habitId),
          eq(habitStickers.weekId, weekId),
          eq(habitStickers.day, day),
        ),
      );
    return c.body(null, 204);
  })
  // FHS-364 — the kid's reward shop: the family's rewards + the kid's own
  // spendable star balance (so the UI can show progress / "ready to claim").
  .get('/rewards', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const db = getDb();
    const [rewardRows, balance] = await Promise.all([
      db
        .select({
          id: rewards.id,
          name: rewards.name,
          description: rewards.description,
          stickerCost: rewards.stickerCost,
          icon: rewards.icon,
        })
        .from(rewards)
        .where(and(eq(rewards.tenantId, kid.tenantId), isNull(rewards.archivedAt)))
        .orderBy(asc(rewards.stickerCost), asc(rewards.createdAt)),
      stickerBalance(db, kid.tenantId, kid.memberId),
    ]);
    return c.json(
      listRewardsResponseSchema.parse({ rewards: rewardRows, stickerBalance: balance }),
    );
  })
  // FHS-364 — the kid claims a reward with their own stars (self-scoped redeem;
  // shared money logic in lib/myworld.ts). 409 when they can't afford it.
  .post('/rewards/:id/redeem', async (c) => {
    const kid = getKidAuth(c);
    const rewardId = c.req.param('id');
    if (!UUID_RE.test(rewardId)) {
      return c.json({ error: 'invalid id', detail: 'reward id must be a UUID' }, 400);
    }
    await pinRequestTenant(kid.tenantId);
    const outcome = await redeemReward(getDb(), {
      tenantId: kid.tenantId,
      memberId: kid.memberId,
      rewardId,
    });
    if (!outcome.ok && outcome.reason === 'not-found') {
      return c.json({ error: 'not found', detail: 'reward not found for this kid' }, 404);
    }
    if (!outcome.ok) {
      return c.json(
        {
          error: 'insufficient stickers',
          errorCode: 'INSUFFICIENT_STICKERS',
          detail: `needs ${outcome.cost}, has ${outcome.balance}`,
        },
        409,
      );
    }
    return c.json(
      kidRedeemResponseSchema.parse({
        stickerBalance: outcome.balance,
        redemptionId: outcome.redemptionId,
      }),
      201,
    );
  })
  // FHS-364 — the kid's money cards: banked savings (stars + cash) + their
  // active investments (live value). Read-only.
  .get('/financial', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const db = getDb();
    const [savings, currency, investments] = await Promise.all([
      getSavings(db, kid.tenantId, kid.memberId),
      getTenantCurrency(db, kid.tenantId),
      listInvestments(db, kid.tenantId, kid.memberId),
    ]);
    return c.json(
      kidFinancialResponseSchema.parse({
        savedStickers: savings.savedStickers,
        savedCash: savings.savedCash,
        currency,
        investments,
      }),
    );
  })
  // FHS-365 — the kid's meals: the family's meal plan scoped to the kid +
  // family-wide entries (server-side, not client-filtered). Read-only.
  .get('/meals', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const rows = await getDb()
      .select({
        id: mealTemplates.id,
        dayOfWeek: mealTemplates.dayOfWeek,
        slot: mealTemplates.slot,
        name: mealTemplates.name,
        memberId: mealTemplates.memberId,
        recurring: mealTemplates.recurring,
      })
      .from(mealTemplates)
      .where(
        and(
          eq(mealTemplates.tenantId, kid.tenantId),
          or(isNull(mealTemplates.memberId), eq(mealTemplates.memberId, kid.memberId)),
        ),
      )
      .orderBy(asc(mealTemplates.dayOfWeek), asc(mealTemplates.slot));
    const meals = rows
      .filter((r) => (r.name ?? '').trim() !== '')
      .map((r) => ({
        id: r.id,
        dayOfWeek: r.dayOfWeek,
        slot: r.slot,
        name: r.name ?? '',
        memberId: r.memberId ?? null,
        recurring: r.recurring,
      }));
    return c.json(listMealsResponseSchema.parse({ meals }));
  })
  // FHS-365 — the kid's schedule for a week (defaults to this week), scoped to
  // the kid + family-wide events. Read-only. Optional ?weekStart=YYYY-MM-DD.
  .get('/events', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const param = c.req.query('weekStart');
    if (param !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(param)) {
      return c.json({ error: 'invalid weekStart', detail: 'must be YYYY-MM-DD' }, 400);
    }
    const weekStart = param ?? mondayOf(new Date()).toISOString().slice(0, 10);
    const [y, m, d] = weekStart.split('-').map((s) => Number.parseInt(s, 10));
    const startMs = Date.UTC(y!, m! - 1, d!);
    // Reject a structurally-valid but nonsense date (e.g. 2026-99-99).
    if (new Date(startMs).toISOString().slice(0, 10) !== weekStart) {
      return c.json({ error: 'invalid weekStart', detail: 'not a real date' }, 400);
    }
    const weekEnd = new Date(startMs + 6 * 86_400_000).toISOString().slice(0, 10);
    const rows = await getDb()
      .select({
        id: events.id,
        date: events.date,
        startTime: events.startTime,
        endTime: events.endTime,
        title: events.title,
        notes: events.notes,
        memberId: events.memberId,
        type: events.type,
        location: events.location,
        wear: events.wear,
      })
      .from(events)
      .where(
        and(
          eq(events.tenantId, kid.tenantId),
          gte(events.date, weekStart),
          lte(events.date, weekEnd),
          or(isNull(events.memberId), eq(events.memberId, kid.memberId)),
        ),
      )
      .orderBy(asc(events.date), asc(events.startTime));
    return c.json(listEventsResponseSchema.parse({ weekStart, events: rows }));
  });
