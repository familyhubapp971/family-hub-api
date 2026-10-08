// FHS-664: OpenAPI entries for the people endpoints. See ../registry.ts.
//
// Covers apps/api/src/routes/{members,invitations,onboarding,health,hello}.ts.
// A few entries here OVERRIDE a baseMeta entry in ../registry.ts for the same
// key because the base entry was wrong (status code or a missing request/
// bodyless marker): see the comment on each one for what was corrected.

import { z } from 'zod';
import { healthResponseSchema } from '../../routes/health.js';
import { helloResponseSchema } from '@familyhub/shared';
import {
  addMemberBodySchema,
  addMemberResponseSchema,
  patchMemberBodySchema,
  pinWriteBodySchema,
  setMemberPinResponseSchema,
} from '../../routes/members.js';
import {
  createInvitationRequestSchema,
  createInvitationResponseSchema,
} from '../../routes/invitations.js';
import {
  completeOnboardingRequestSchema,
  completeOnboardingResponseSchema,
} from '../../routes/onboarding.js';
import { getStartedDismissResponseSchema } from '@familyhub/shared';
import type { RouteMeta } from '../registry.js';

export const peopleMeta: Record<string, RouteMeta> = {
  // ── System ──────────────────────────────────────────────────────────────
  // Corrects baseMeta: neither entry carried a response schema, which
  // findUndocumented flags as a gap.
  'GET /health': {
    summary: 'Liveness probe: is the process up and serving requests',
    response: healthResponseSchema,
    responseDesc: '{ status: "ok", version, uptime } where uptime is seconds since process start',
  },
  'GET /hello': {
    summary: 'Hello sanity check: a static greeting plus the current time',
    response: helloResponseSchema,
    responseDesc: '{ message, timestamp }',
  },

  // ── Members: roster edits (FHS-276 / FHS-473) ────────────────────────────
  // Corrects baseMeta: the handler returns 201 on success (a new seat), but
  // the base entry had no `status`, which defaults to 200.
  'POST /api/members': {
    summary: 'Add a family member seat (child, teen, or adult); admin only',
    description: 'No login is created: this is a direct roster insert, not an invite.',
    request: addMemberBodySchema,
    response: addMemberResponseSchema,
    responseDesc: '201: the created member row (id, displayName, role)',
    status: 201,
  },
  'PATCH /api/members/{id}': {
    summary: 'Rename a member and/or toggle their admin↔adult role; admin only',
    description:
      "role may only move between admin and adult (kid roles are fixed at creation). The target must already be adult/admin to be touched; an admin can't demote themselves, and the last remaining admin can never be demoted or removed. 400 with a reason when a guard blocks the change; 404 if the member is not in this tenant.",
    request: patchMemberBodySchema,
    // Same shape as POST /api/members: { member: { id, displayName, role } }.
    response: addMemberResponseSchema,
    responseDesc: 'The updated member row',
  },
  'DELETE /api/members/{id}': {
    summary: 'Remove a member from the family; admin only',
    description:
      'Their content (tasks, habits, etc.) cascades with them. The last remaining admin can never be removed. 404 if the member is not in this tenant.',
    response: z.object({ deleted: z.literal(true) }),
    responseDesc: '{ deleted: true }',
  },

  // ── Members: kid PIN login (FHS-252) ────────────────────────────────────
  // Corrects baseMeta: the entry had a response but no request schema.
  'PUT /api/members/{id}/pin': {
    summary: "Set a kid member's 4-digit login PIN; admin or adult only",
    description:
      'The target must have role child or teen (403 PIN_TARGET_INELIGIBLE otherwise). Setting a PIN also flips isChild on. Clears any existing lockout from prior wrong attempts.',
    request: pinWriteBodySchema,
    response: setMemberPinResponseSchema,
  },
  'DELETE /api/members/{id}/pin': {
    summary: "Clear a kid member's login PIN; admin or adult only",
    description: 'Also flips isChild off and clears any existing lockout bucket.',
    bodyless: true,
    response: setMemberPinResponseSchema,
    responseDesc: 'The member row with hasPin: false',
  },

  // ── Members: self-serve sign-in email change (FHS-510) ──────────────────
  // Corrects baseMeta: the entry had a responseDesc but no `response` schema
  // and no `bodyless` marker, so findUndocumented still flagged it.
  'POST /api/members/{id}/email-change/cancel': {
    summary: "Cancel the caller's own pending sign-in email change; self-serve only",
    description:
      "403 if the target id is not the caller's own member row. Always 200, even if there was nothing pending.",
    bodyless: true,
    response: z.object({ cancelled: z.literal(true) }),
    responseDesc: '{ cancelled: true }: always, even if there was nothing pending',
  },

  // ── Invitations (FHS-91 / FHS-275 / FHS-276) ────────────────────────────
  // Corrects baseMeta: the handler returns 201 on success (a new invitation),
  // but the base entry had no `status`, which defaults to 200.
  'POST /api/invitations': {
    summary: 'Invite someone to the family; admin or adult only',
    description:
      "role is one of admin | adult | teen | guest (default adult). Granting 'admin' " +
      'requires the caller to already be an admin (403 otherwise): FHS-486 / ADR 0019.',
    request: createInvitationRequestSchema,
    response: createInvitationResponseSchema,
    responseDesc: '201: the created pending invitation',
    status: 201,
  },
  // Corrects baseMeta: no response schema and no bodyless marker.
  'POST /api/invitations/claim': {
    summary: "Claim invites addressed to the caller's own email",
    description:
      'Called right after sign-in when the caller has no membership yet. For each matching pending invitation, links an unclaimed seat (or creates one, for a members-page invite with no pre-created seat) to the caller and flips the invitation to accepted. No tenant header required: the invitation rows carry the tenant scope.',
    bodyless: true,
    response: z.object({
      claimed: z.array(z.object({ tenantId: z.string().uuid(), slug: z.string() })),
    }),
    responseDesc: 'claimed[]: one entry per family the caller just joined (empty if none matched)',
  },
  'POST /api/invitations/{id}/resend': {
    summary: 'Resend a still-pending invitation email; admin or adult only',
    description:
      "Re-fires the Supabase invite email (e.g. a typo'd address, or the email got lost). 404 if the invitation is not in this tenant; 409 if it is no longer pending (already accepted/expired).",
    bodyless: true,
    response: z.object({ resent: z.literal(true) }),
    responseDesc: '{ resent: true }',
  },

  // ── Onboarding (FHS-37 / FHS-275 / FHS-634) ─────────────────────────────
  'POST /api/onboarding/complete': {
    summary: 'Finish the onboarding wizard; admin only',
    description:
      'Atomically sets tenant timezone/currency, renames the caller to yourName (if given), inserts one members row per wizard-added member, marks onboarding_completed, seeds starter habits/rewards, then best-effort emails an invite to each adult member that carried an email. Idempotent: a repeat call after completion returns the current tenant unchanged with membersAdded: 0, invitesSent: 0.',
    request: completeOnboardingRequestSchema,
    response: completeOnboardingResponseSchema,
    responseDesc:
      'The updated tenant plus membersAdded and invitesSent counts (invite send failures are logged but never fail this response or roll back the family)',
  },
  // Corrects baseMeta: the handler reads no body, but the base entry had
  // neither `request` nor `bodyless`, so findUndocumented still flagged it.
  'POST /api/onboarding/get-started/dismiss': {
    summary: 'Hide the dashboard setup guide for the calling admin, on every device',
    bodyless: true,
    response: getStartedDismissResponseSchema,
    responseDesc:
      'Always { dismissed: true }. Idempotent: a repeat call keeps the original timestamp. 403 for non-admins',
  },
};
