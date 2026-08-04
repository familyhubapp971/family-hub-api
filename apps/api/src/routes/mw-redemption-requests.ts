import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { isAdmin, loadCaller } from '../lib/permissions.js';
import {
  approveRedemptionRequest,
  declineRedemptionRequest,
  listRedemptionRequests,
} from '../lib/myworld.js';

// FHS-376: parent-facing redemption-request inbox.
//
// Kids ASK to redeem a reward (POST /api/kid/rewards/:id/request); those land
// here as pending rows. An admin parent approves (deducts star_cost from the
// kid's SAVINGS only) or declines. Reads are open to any family member; the
// approve/decline DECISION is admin-only, SERVER-enforced (not just a hidden
// button): a non-admin gets 403.
//
// Mounted at /api/mw/redemption-requests behind the normal adult auth + tenant
// middleware (same stack as /api/mw/financial).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const redemptionRequestListItemSchema = z.object({
  id: z.string().uuid(),
  memberId: z.string().uuid(),
  memberName: z.string(),
  rewardId: z.string().uuid(),
  rewardName: z.string(),
  rewardIcon: z.string().nullable(),
  starCost: z.number().int(),
  status: z.enum(['pending', 'approved', 'declined']),
  requestedAt: z.string(),
});

export const listRedemptionRequestsResponseSchema = z.object({
  requests: z.array(redemptionRequestListItemSchema),
});

export const decideRedemptionRequestResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['approved', 'declined']),
});

const statusQuerySchema = z.enum(['pending', 'approved', 'declined']);

// Resolve the caller's membership for this tenant. Returns the loaded caller
// (id + role) or a Response to short-circuit (no tenant / not a member).
async function resolveCaller(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
): Promise<
  | { db: ReturnType<typeof getDb>; tenantId: string; caller: { id: string; role: string } }
  | { res: Response }
> {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('redemption-requests handler reached without userRow');
  const tenantId = c.get('tenantId');
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

export const mwRedemptionRequestsRouter = new Hono()
  // List the family's requests (?status=pending|approved|declined). ANY member
  // of the tenant may read: no admin gate on the read.
  .get('/', async (c) => {
    const g = await resolveCaller(c);
    if ('res' in g) return g.res;
    const statusParam = c.req.query('status');
    let status: 'pending' | 'approved' | 'declined' | undefined;
    if (statusParam !== undefined) {
      const parsed = statusQuerySchema.safeParse(statusParam);
      if (!parsed.success) {
        return c.json(
          { error: 'invalid request', detail: 'status must be pending|approved|declined' },
          400,
        );
      }
      status = parsed.data;
    }
    const requests = await listRedemptionRequests(g.db, g.tenantId, status);
    return c.json(listRedemptionRequestsResponseSchema.parse({ requests }));
  })
  // Approve a pending request: ADMIN ONLY (server-enforced). Deducts star_cost
  // from the kid's SAVINGS only; 400 if savings can't cover it (no change).
  .post('/:id/approve', async (c) => {
    const g = await resolveCaller(c);
    if ('res' in g) return g.res;
    if (!isAdmin(g.caller)) {
      return c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'admin role required' },
        403,
      );
    }
    const requestId = c.req.param('id');
    if (!UUID_RE.test(requestId)) {
      return c.json({ error: 'invalid id', detail: 'request id must be a UUID' }, 400);
    }
    const outcome = await approveRedemptionRequest(g.db, {
      tenantId: g.tenantId,
      requestId,
      decidedBy: g.caller.id,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not-found') {
        return c.json({ error: 'not found', detail: 'request not found in this tenant' }, 404);
      }
      if (outcome.reason === 'not-pending') {
        return c.json(
          { error: 'conflict', errorCode: 'NOT_PENDING', detail: 'request already decided' },
          409,
        );
      }
      // insufficient-savings.
      return c.json(
        {
          error: 'not enough savings',
          errorCode: 'INSUFFICIENT_SAVINGS',
          detail: `needs ${outcome.cost} saved stars, has ${outcome.savings}`,
        },
        400,
      );
    }
    return c.json(
      decideRedemptionRequestResponseSchema.parse({ id: requestId, status: 'approved' }),
    );
  })
  // Decline a pending request: ADMIN ONLY (server-enforced). No deduction.
  .post('/:id/decline', async (c) => {
    const g = await resolveCaller(c);
    if ('res' in g) return g.res;
    if (!isAdmin(g.caller)) {
      return c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'admin role required' },
        403,
      );
    }
    const requestId = c.req.param('id');
    if (!UUID_RE.test(requestId)) {
      return c.json({ error: 'invalid id', detail: 'request id must be a UUID' }, 400);
    }
    const outcome = await declineRedemptionRequest(g.db, {
      tenantId: g.tenantId,
      requestId,
      decidedBy: g.caller.id,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not-found') {
        return c.json({ error: 'not found', detail: 'request not found in this tenant' }, 404);
      }
      return c.json(
        { error: 'conflict', errorCode: 'NOT_PENDING', detail: 'request already decided' },
        409,
      );
    }
    return c.json(
      decideRedemptionRequestResponseSchema.parse({ id: requestId, status: 'declined' }),
    );
  });
