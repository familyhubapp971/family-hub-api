// FHS-664: OpenAPI entries for the money endpoints. See ../registry.ts.
//
// Covers apps/api/src/routes/{rewards,mw-redemption-requests,mw-weeks}.ts and
// the money-adjacent endpoints in apps/api/src/routes/kid.ts (the reward shop,
// reward requests, tasks, reading log, week actions). A few entries here
// OVERRIDE a baseMeta entry in ../registry.ts for the same key because the
// base entry had the wrong status code or was missing a `bodyless`/response
// marker: see the comment on each one for what was corrected.

import { z } from 'zod';
import {
  listRewardsResponseSchema,
  rewardItemSchema,
  createRewardRequestSchema,
  redeemRequestSchema,
  memberQuerySchema,
} from '../../routes/rewards.js';
import { decideRedemptionRequestResponseSchema } from '../../routes/mw-redemption-requests.js';
import {
  finalizeRequestSchema,
  memberBodySchema,
  weekActionsResponseSchema,
  weekCashRequestSchema,
  weekResponseSchema,
} from '../../routes/mw-weeks.js';
import { kidTaskPatchSchema, kidRedemptionRequestSchema } from '../../routes/kid.js';
import type { RouteMeta } from '../registry.js';

// The week actions build their replies inline in mw-weeks.ts; mirrored here.
const finalizeResponseSchema = z.object({
  finalized: z.literal(true),
  stickersAutoSaved: z.number(),
  investmentReturns: z.number(),
  continuedInvestments: z.number().int(),
  skipPenaltyMinor: z.number().int(),
  nextWeekId: z.string().uuid(),
  nextWeekNumber: z.number().int(),
  nextWeekYear: z.number().int(),
});
const reversalSchema = z.object({
  stickersReversed: z.number(),
  cashReversed: z.number(),
  investmentsRestored: z.number().int(),
  skipPenaltyReversedMinor: z.number().int(),
});
const reopenResponseSchema = z.object({
  reopened: z.literal(true),
  weekId: z.string().uuid(),
  reversal: reversalSchema,
});
const repairResponseSchema = z.object({
  repaired: z.literal(true),
  weekId: z.string().uuid(),
  reversal: reversalSchema,
});

// The redeem reply isn't backed by a named schema in rewards.ts (the handler
// builds the object inline), so it's mirrored here field for field.
const redeemResponseSchema = z.object({
  stickerBalance: z.number().int(),
  redemptionId: z.string().uuid(),
});

// Same for the kid task-toggle reply: the handler returns a bare `{ ok: true }`.
const kidTaskPatchResponseSchema = z.object({ ok: z.literal(true) });

export const moneyMeta: Record<string, RouteMeta> = {
  // ── Reward shop (parent/adult view) ──────────────────────────────────────
  'GET /api/rewards': {
    summary: "A child's reward shop + sticker balance; any tenant member may view it",
    queryParams: {
      memberId: {
        description: 'UUID of the child member whose reward shop + balance to fetch',
        required: true,
        schema: memberQuerySchema.shape.memberId,
      },
    },
    response: listRewardsResponseSchema,
    responseDesc: "The family's non-archived rewards, plus that member's sticker balance",
  },
  'POST /api/rewards/{id}/redeem': {
    summary:
      "Spend a child's stickers on a reward; any tenant member may redeem on a child's behalf",
    request: redeemRequestSchema,
    response: redeemResponseSchema,
    responseDesc:
      'The sticker balance after the spend + the new redemption id. 409 INSUFFICIENT_STICKERS if the balance cannot cover the cost',
    status: 201,
  },
  // Corrects baseMeta: the create reply really is 201 (c.json(..., 201) in the
  // handler), but the entry never set `status`, so the generated spec
  // documented 200.
  'POST /api/rewards': {
    summary: 'Create a reward in the family reward shop; admin-only',
    request: createRewardRequestSchema,
    response: rewardItemSchema,
    responseDesc: 'The created reward',
    status: 201,
  },
  // Corrects baseMeta: the handler replies with `c.body(null, 204)` (no JSON),
  // but the entry never set `status`, so the generated spec documented 200
  // with no response schema, i.e. "200 with an empty body" instead of 204.
  'DELETE /api/rewards/{id}': {
    summary: 'Archive (soft-delete) a reward; admin-only',
    status: 204,
    responseDesc:
      "204 on success. 404 if the reward is not in the caller's tenant or is already archived. Never a hard delete: reward_redemptions/redemption_requests keep their FK for history",
  },

  // ── Redemption requests (FHS-376): kid asks, admin approves/declines ─────
  // Corrects baseMeta: neither approve nor decline reads a request body (no
  // `c.req.json()` call), but the entry carried no `request` and no
  // `bodyless: true`, which `findUndocumented` flags as a gap.
  'POST /api/mw/redemption-requests/{id}/approve': {
    summary:
      "Approve a child's reward request: admin only; deducts star_cost from the child's savings",
    bodyless: true,
    response: decideRedemptionRequestResponseSchema,
    responseDesc:
      '{ id, status: "approved" }. 404 if not in this tenant, 409 NOT_PENDING if already decided, 400 INSUFFICIENT_SAVINGS if savings cannot cover the cost',
  },
  'POST /api/mw/redemption-requests/{id}/decline': {
    summary: "Decline a child's reward request: admin only; no deduction",
    bodyless: true,
    response: decideRedemptionRequestResponseSchema,
    responseDesc:
      '{ id, status: "declined" }. 404 if not in this tenant, 409 NOT_PENDING if already decided',
  },

  // ── Kid-scoped (kid token) ────────────────────────────────────────────────
  // Corrects baseMeta: the handler reads no body, but the entry had no
  // `bodyless: true`, which `findUndocumented` flags as a gap.
  'POST /api/kid/rewards/{id}/request': {
    summary: 'The signed-in kid asks to redeem a reward; no deduction yet, an admin must approve',
    bodyless: true,
    response: kidRedemptionRequestSchema,
    responseDesc:
      'The pending request row (idempotent: a repeat ask while one is already pending returns that same row, not a new one)',
  },
  'PATCH /api/kid/tasks/{id}': {
    summary: "Tick or untick one of the signed-in kid's own tasks",
    request: kidTaskPatchSchema,
    response: kidTaskPatchResponseSchema,
    responseDesc: "404 if the task doesn't belong to this kid",
  },
  // Corrects baseMeta: the handler replies with `c.body(null, 204)` (no JSON,
  // and no existence check first), but the entry never set `status`, so the
  // generated spec documented 200 with no response schema.
  'DELETE /api/kid/reading-log/{id}': {
    summary: "Remove a book from the signed-in kid's reading log",
    status: 204,
    responseDesc: "Always 204: there is no check that the id belonged to one of this kid's books",
  },
  // Corrects baseMeta: the entry had a summary but no response schema, which
  // `findUndocumented` flags as a gap.
  'GET /api/kid/weeks/{id}/actions': {
    summary: "Audit log of actions on one of the signed-in kid's own weeks",
    response: weekActionsResponseSchema,
    responseDesc:
      "Identical shape to GET /api/mw/weeks/{id}/actions, newest first. 404 if the week doesn't belong to this kid",
  },

  // Corrects baseMeta: the four week actions had a description but no reply shape.
  'POST /api/mw/weeks/{id}/finalize': {
    summary: 'Close a week and start the next one. ADMIN ONLY',
    request: finalizeRequestSchema,
    response: finalizeResponseSchema,
    responseDesc:
      'Banks anything spare, settles investments, applies skip penalties, and carries the rest forward. Name the investments to keep running in continueInvestmentIds',
  },
  'POST /api/mw/weeks/{id}/reopen': {
    summary: 'Undo a close, putting the week back as it was. ADMIN ONLY',
    request: memberBodySchema,
    response: reopenResponseSchema,
    responseDesc: 'Reverses what the close did: banking, investment settlement and any penalty',
  },
  'POST /api/mw/weeks/{id}/repair': {
    summary: 'Clear leftover close effects from a week that is still open. ADMIN ONLY',
    request: memberBodySchema,
    response: repairResponseSchema,
    responseDesc: 'For a week left half-closed by an interrupted finalize',
  },
  'PUT /api/mw/weeks/{id}/cash': {
    summary: "Correct a week's carried and retrieved cash by hand. ADMIN ONLY",
    request: weekCashRequestSchema,
    response: weekResponseSchema,
    responseDesc: 'The updated week. Neither figure may be negative',
  },
};
