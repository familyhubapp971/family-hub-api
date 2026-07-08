import { Hono } from 'hono';
import { and, eq, gte } from 'drizzle-orm';
import { getDb, pinRequestTenant } from '../db/client.js';
import { events, tenants } from '../db/schema.js';
import { config } from '../config.js';
import {
  parseFeedToken,
  verifyFeedSignature,
  buildIcs,
  feedCutoffDate,
  type FeedEvent,
} from '../lib/calendar-feed.js';

// FHS-445 — the PUBLIC calendar feed. No auth: the signed token in the URL is
// the credential (mounted under /api/public/calendar, in PUBLIC_PATH_PREFIXES).
//
// GET /api/public/calendar/:token(.ics)  → text/calendar (ICS) of the family's
//                                           activities, for Google/Apple/Outlook.
//
// Security order is deliberate: parse the token (no DB), pin its claimed tenant,
// read ONLY that tenant's feed key + metadata, verify the signature in constant
// time, and only THEN read events. A forged or rotated-out token 404s before a
// single activity row is touched — no cross-tenant leak. Every bad case returns
// the same bare 404 so the endpoint reveals nothing about which families exist.

// Only surface events from this far back so the feed stays bounded as a family
// accrues years of history; future events are always included.
const PAST_WINDOW_DAYS = 90;

export const publicCalendarRouter = new Hono().get('/:token', async (c) => {
  const parsed = parseFeedToken(c.req.param('token'));
  if (!parsed) return c.notFound();

  // Pin the claimed tenant so the reads below are scoped to it (and pass RLS
  // once enforced). The claim is not trusted until the signature check passes.
  await pinRequestTenant(parsed.tenantId);
  const db = getDb();

  const [tenant] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      timezone: tenants.timezone,
      key: tenants.calendarFeedKey,
    })
    .from(tenants)
    .where(eq(tenants.id, parsed.tenantId));

  if (
    !tenant ||
    !verifyFeedSignature(parsed.tenantId, tenant.key, parsed.sig, config.CALENDAR_FEED_SECRET)
  ) {
    return c.notFound();
  }

  const now = new Date();
  const rows = await db
    .select({
      id: events.id,
      date: events.date,
      startTime: events.startTime,
      endTime: events.endTime,
      title: events.title,
      notes: events.notes,
      location: events.location,
      updatedAt: events.updatedAt,
    })
    .from(events)
    .where(
      and(
        eq(events.tenantId, parsed.tenantId),
        gte(events.date, feedCutoffDate(now, PAST_WINDOW_DAYS)),
      ),
    )
    .orderBy(events.date);

  const ics = buildIcs({
    events: rows as FeedEvent[],
    familyName: tenant.name,
    tzid: tenant.timezone || 'UTC',
    now,
  });

  c.header('Content-Type', 'text/calendar; charset=utf-8');
  c.header('Content-Disposition', 'inline; filename="familyhub.ics"');
  // Let calendar clients cache briefly; they poll on their own cadence anyway.
  c.header('Cache-Control', 'private, max-age=300');
  return c.body(ics);
});
