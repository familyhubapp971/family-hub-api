import { Hono } from 'hono';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { tenants } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, isAdmin } from '../lib/permissions.js';
import { config } from '../config.js';
import { generateFeedKey, signFeedToken } from '../lib/calendar-feed.js';

// FHS-445 — calendar sync: the family-facing feed-management endpoints.
//
// GET  /api/calendar/feed         → the family's subscribe URL (creates the
//                                    per-family feed key on first call). Any
//                                    member may fetch it.
// POST /api/calendar/feed/rotate  → regenerate the key (admin-only). Old
//                                    subscriptions stop working immediately.
//
// The public ICS endpoint that the URL points at lives in
// routes/public-calendar.ts (no auth — the signed token is the credential).

export const calendarFeedResponseSchema = z.object({
  // Absolute webcal/https URL a user pastes into Google / Apple / Outlook.
  url: z.string(),
});

type Db = ReturnType<typeof getDb>;

async function guardTenant(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
): Promise<{ db: Db; tenantId: string; caller: { id: string; role: string } } | { res: Response }> {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('calendar handler reached without userRow');
  const tenantId = c.get('tenantId') as string | undefined;
  if (!tenantId) {
    return { res: c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400) };
  }
  const db = getDb();
  const caller = await loadCaller(db, tenantId, userRow.id);
  if (!caller) {
    return { res: c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403) };
  }
  return { db, tenantId, caller };
}

// The public origin the api is reachable at, so the returned URL is absolute
// (calendar apps can't resolve a relative path). Prefer the configured
// API_PUBLIC_URL (trusted) over the client-supplied Host header; fall back to
// the request origin in dev/tests where the env isn't set.
function publicOrigin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
): string {
  if (config.API_PUBLIC_URL) return config.API_PUBLIC_URL.replace(/\/$/, '');
  const host = c.req.header('host');
  if (host) {
    const proto = c.req.header('x-forwarded-proto') ?? 'https';
    return `${proto}://${host}`;
  }
  return new URL(c.req.url).origin;
}

function feedUrl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  tenantId: string,
  feedKey: string,
): string {
  const token = signFeedToken(tenantId, feedKey, config.CALENDAR_FEED_SECRET);
  return `${publicOrigin(c)}/api/public/calendar/${token}.ics`;
}

export const calendarRouter = new Hono()
  // GET /api/calendar/feed — the family's subscribe URL. Lazily creates the
  // per-family feed key on first access. Any member may read it.
  .get('/feed', async (c) => {
    const ctx = await guardTenant(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId } = ctx;

    // Atomic create-on-first-use: COALESCE keeps any existing key and only
    // writes the candidate when the column is still null, so two members
    // opening the card at once converge on ONE persisted key (no lost-write
    // race where the loser gets a URL signed with a key that was never saved).
    const candidate = generateFeedKey();
    const [row] = await db
      .update(tenants)
      .set({ calendarFeedKey: sql`coalesce(${tenants.calendarFeedKey}, ${candidate})` })
      .where(eq(tenants.id, tenantId))
      .returning({ key: tenants.calendarFeedKey });
    if (!row?.key) return c.json({ error: 'tenant not found' }, 404);

    return c.json({ url: feedUrl(c, tenantId, row.key) });
  })

  // POST /api/calendar/feed/rotate — regenerate the key; admin-only. Every
  // existing subscription (old URL) 404s from here on.
  .post('/feed/rotate', async (c) => {
    const ctx = await guardTenant(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId, caller } = ctx;

    if (!isAdmin(caller)) {
      return c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'admin role required' },
        403,
      );
    }

    const key = generateFeedKey();
    await db
      .update(tenants)
      .set({ calendarFeedKey: key, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    return c.json({ url: feedUrl(c, tenantId, key) });
  });
