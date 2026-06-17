import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, min } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { journalEntries } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, canManage, memberInTenant } from '../lib/permissions.js';
import {
  JOURNAL_QUOTES,
  JOURNAL_CREATIVITY_QUESTIONS,
  JOURNAL_MOODS,
  quoteIndexForDate,
} from '@familyhub/shared';

// FHS-270 — per-day journal API.
//
// One row per (tenant, member, calendar day), upserted via PUT /.
// Auth helpers are kept from the original: loadCaller, canManage,
// memberInTenant enforce the same "child OR admin/adult" scoping.

// ─── Zod schemas (exported so tests can import shapes) ────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A YYYY-MM-DD string that is also a REAL calendar date (rejects 2026-02-30,
// 2026-13-01) — the regex alone would let those through to Postgres and 500.
function isValidCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Not in the future. We allow up to UTC-today + 1 day so a child whose local
// date is ahead of UTC (e.g. UTC+14 near midnight) can still save "today";
// this still blocks pre-dating entries weeks/years ahead.
function isNotFuture(s: string): boolean {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return s <= tomorrow.toISOString().slice(0, 10);
}

const MOOD_VALUES = [
  'happy',
  'smiling',
  'excited',
  'laughing',
  'surprised',
  'nervous',
  'grumpy',
  'sad',
] as const;

export const journalEntrySchema = z.object({
  id: z.string().uuid(),
  entryDate: z.string().regex(DATE_RE),
  mood: z.enum(MOOD_VALUES).nullable(),
  gratitude1: z.string().nullable(),
  gratitude2: z.string().nullable(),
  gratitude3: z.string().nullable(),
  quoteIndex: z.number().int().nonnegative().nullable(),
  creativity: z.record(z.string(), z.string()).nullable(),
  body: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const journalDayResponseSchema = z.object({
  entry: journalEntrySchema.nullable(),
  quoteIndex: z.number().int().nonnegative(),
});

export const journalEntriesResponseSchema = z.object({
  entries: z.array(journalEntrySchema),
});

export const journalEarliestResponseSchema = z.object({
  earliestDate: z.string().regex(DATE_RE).nullable(),
});

export const journalContentResponseSchema = z.object({
  quotes: z.array(z.object({ text: z.string(), author: z.string() })),
  creativityQuestions: z.array(
    z.object({
      emoji: z.string(),
      label: z.string(),
      placeholder: z.string(),
      color: z.string(),
    }),
  ),
  moods: z.array(
    z.object({
      value: z.string(),
      emoji: z.string(),
      label: z.string(),
    }),
  ),
});

const upsertRequestSchema = z.object({
  memberId: z.string().uuid(),
  entryDate: z
    .string()
    .regex(DATE_RE, 'entryDate must be YYYY-MM-DD')
    .refine(isValidCalendarDate, 'entryDate must be a real calendar date')
    .refine(isNotFuture, 'entryDate may not be in the future'),
  mood: z.enum(MOOD_VALUES).nullish(),
  gratitude1: z.string().max(500).nullish(),
  gratitude2: z.string().max(500).nullish(),
  gratitude3: z.string().max(500).nullish(),
  body: z.string().max(5000).nullish(),
  creativity: z.record(z.string(), z.string()).nullish(),
});

// ─── Response serialiser ──────────────────────────────────────────────────────

function serializeEntry(r: typeof journalEntries.$inferSelect): z.infer<typeof journalEntrySchema> {
  return {
    id: r.id,
    entryDate: r.entryDate,
    mood: r.mood ?? null,
    gratitude1: r.gratitude1 ?? null,
    gratitude2: r.gratitude2 ?? null,
    gratitude3: r.gratitude3 ?? null,
    quoteIndex: r.quoteIndex ?? null,
    creativity: (r.creativity as Record<string, string> | null) ?? null,
    body: r.body ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const journalRouter = new Hono()

  // GET /content — static data; auth + tenant required but no member scope.
  .get('/content', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('journal/content handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    return c.json(
      journalContentResponseSchema.parse({
        quotes: JOURNAL_QUOTES,
        creativityQuestions: JOURNAL_CREATIVITY_QUESTIONS,
        moods: JOURNAL_MOODS,
      }),
    );
  })

  // GET /earliest?memberId= — oldest entryDate for back-nav lower bound.
  .get('/earliest', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('journal/earliest handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const parsed = z.object({ memberId: z.string().uuid() }).safeParse({
      memberId: c.req.query('memberId'),
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);
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
      .select({ earliest: min(journalEntries.entryDate) })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.memberId, parsed.data.memberId),
        ),
      );
    const earliestDate = rows[0]?.earliest ?? null;
    return c.json(journalEarliestResponseSchema.parse({ earliestDate }));
  })

  // GET /entries?memberId= — all entries newest-first (Past Entries view).
  .get('/entries', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('journal/entries handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const parsed = z.object({ memberId: z.string().uuid() }).safeParse({
      memberId: c.req.query('memberId'),
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);
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
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.memberId, parsed.data.memberId),
        ),
      )
      .orderBy(desc(journalEntries.entryDate));
    return c.json(journalEntriesResponseSchema.parse({ entries: rows.map(serializeEntry) }));
  })

  // GET /?memberId=&date=YYYY-MM-DD — entry for a specific day (or null) + quoteIndex.
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('journal handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const parsed = z
      .object({
        memberId: z.string().uuid(),
        date: z
          .string()
          .regex(DATE_RE, 'date must be YYYY-MM-DD')
          .refine(isValidCalendarDate, 'date must be a real calendar date'),
      })
      .safeParse({ memberId: c.req.query('memberId'), date: c.req.query('date') });
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
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.memberId, parsed.data.memberId),
          eq(journalEntries.entryDate, parsed.data.date),
        ),
      )
      .limit(1);
    const computedQuoteIndex = quoteIndexForDate(parsed.data.date);
    return c.json(
      journalDayResponseSchema.parse({
        entry: rows[0] ? serializeEntry(rows[0]) : null,
        quoteIndex: computedQuoteIndex,
      }),
    );
  })

  // PUT / — upsert entry for (tenantId, memberId, entryDate).
  .put('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('journal PUT handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const rawBody = (await c.req.json().catch(() => null)) as unknown;
    const parsed = upsertRequestSchema.safeParse(rawBody);
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

    const { memberId, entryDate, mood, gratitude1, gratitude2, gratitude3, body, creativity } =
      parsed.data;
    const computedQuoteIndex = quoteIndexForDate(entryDate);
    const now = new Date();

    const [row] = await db
      .insert(journalEntries)
      .values({
        tenantId,
        memberId,
        entryDate,
        mood: mood ?? null,
        gratitude1: gratitude1 ?? null,
        gratitude2: gratitude2 ?? null,
        gratitude3: gratitude3 ?? null,
        quoteIndex: computedQuoteIndex,
        creativity: creativity ?? {},
        body: body ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [journalEntries.tenantId, journalEntries.memberId, journalEntries.entryDate],
        set: {
          mood: mood ?? null,
          gratitude1: gratitude1 ?? null,
          gratitude2: gratitude2 ?? null,
          gratitude3: gratitude3 ?? null,
          quoteIndex: computedQuoteIndex,
          creativity: creativity ?? {},
          body: body ?? null,
          updatedAt: now,
        },
      })
      .returning();

    if (!row) return c.json({ error: 'upsert failed', errorCode: 'JOURNAL_UPSERT_NO_ROW' }, 500);
    return c.json(journalEntrySchema.parse(serializeEntry(row)), 200);
  });
