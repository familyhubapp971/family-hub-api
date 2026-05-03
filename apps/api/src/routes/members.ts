import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-108 — GET /api/members.
//
// Returns every member of the resolved tenant. Auth-gated; the caller
// must be a member of the tenant (any role). Used by the /t/:slug/members
// page to render the family list with role + status badges.
//
// Status is derived per row, not stored:
//   - active    — user_id IS NOT NULL (a real Supabase user is linked)
//   - unclaimed — user_id IS NULL (admin added the seat; nobody has
//     accepted yet — could be a wizard-added member or a pending invite
//     pre-acceptance)

const memberStatusValues = ['active', 'unclaimed'] as const;
type MemberStatus = (typeof memberStatusValues)[number];

export const memberItemSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  role: z.string(),
  avatarEmoji: z.string().nullable(),
  status: z.enum(memberStatusValues),
  createdAt: z.string().datetime(),
});

export const listMembersResponseSchema = z.object({
  members: z.array(memberItemSchema),
});

export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;

export const membersRouter = new Hono().get('/', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) {
    throw new Error('members handler reached without userRow on context');
  }
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return c.json(
      {
        error: 'tenant context required',
        errorCode: 'TENANT_REQUIRED',
        detail: 'no tenantId resolved on this request',
      },
      400,
    );
  }

  const db = getDb();

  // Authorization: caller must be a member of the tenant. Any role
  // can list members (this is a read-only view of the family).
  const callerRows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userRow.id)))
    .limit(1);
  if (callerRows.length === 0) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }

  // Members list — ordered by creation so the founding admin sits at
  // the top and the most recently added rows trail the list.
  const rows = await db
    .select({
      id: members.id,
      displayName: members.displayName,
      role: members.role,
      avatarEmoji: members.avatarEmoji,
      userId: members.userId,
      createdAt: members.createdAt,
    })
    .from(members)
    .where(eq(members.tenantId, tenantId))
    .orderBy(asc(members.createdAt));

  const response: ListMembersResponse = {
    members: rows.map((r) => {
      const status: MemberStatus = r.userId ? 'active' : 'unclaimed';
      return {
        id: r.id,
        displayName: r.displayName,
        role: r.role,
        avatarEmoji: r.avatarEmoji,
        status,
        createdAt: r.createdAt.toISOString(),
      };
    }),
  };
  return c.json(listMembersResponseSchema.parse(response));
});
