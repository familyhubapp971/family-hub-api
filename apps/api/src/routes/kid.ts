import { Hono } from 'hono';
import { z } from 'zod';
import { kidAuthMiddleware, requireKidAuth, getKidAuth } from '../middleware/kid-auth.js';
import { getDb } from '../db/client.js';
import { listTenantNotices, listNoticesResponseSchema } from './notices.js';

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

export const kidRouter = new Hono()
  .use('*', kidAuthMiddleware())
  .use('*', requireKidAuth)
  .get('/me', (c) => {
    const kid = getKidAuth(c);
    return c.json(kidMeResponseSchema.parse(kid));
  })
  // FHS-355 — the family noticeboard, scoped to the kid's own tenant from the
  // verified kid token. Same shape as GET /api/notices.
  .get('/notices', async (c) => {
    const kid = getKidAuth(c);
    const notices = await listTenantNotices(getDb(), kid.tenantId);
    return c.json(listNoticesResponseSchema.parse({ notices }));
  });
