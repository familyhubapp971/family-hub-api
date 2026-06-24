// FHS-356 — OpenAPI enrichment registry.
//
// Every endpoint is discovered automatically from the live Hono route table
// (see build-spec.ts), so the spec can never silently miss a route. This map
// only adds the human-friendly detail on top: a summary plus the request /
// response shape, reusing the SAME Zod schemas the handlers validate with — so
// the docs can't drift from the contract.
//
// Keyed by `${METHOD} ${openApiPath}` where openApiPath uses `{param}` (not
// Hono's `:param`). Endpoints not listed here still appear in the spec with an
// auto-generated summary and a generic 200 response — fill them in over time.

import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { meResponseSchema } from '../routes/me.js';
import {
  kidInvestmentsResponseSchema,
  kidMeResponseSchema,
  kidProfileResponseSchema,
  kidRedemptionRequestSchema,
  kidRewardsResponseSchema,
  kidSavingsResponseSchema,
  kidTasksResponseSchema,
  kidTodayResponseSchema,
  kidWeeksResponseSchema,
  kidWeekStatsResponseSchema,
  kidWorldFlagsExploredResponseSchema,
  kidWorldFlagsLearnResponseSchema,
} from '../routes/kid.js';
import { listHabitsResponseSchema } from '../routes/habits.js';
import {
  decideRedemptionRequestResponseSchema,
  listRedemptionRequestsResponseSchema,
} from '../routes/mw-redemption-requests.js';
import { listMealsResponseSchema } from '../routes/meals.js';
import { listEventsResponseSchema } from '../routes/events.js';
import {
  journalDayResponseSchema,
  journalEntriesResponseSchema,
  journalEarliestResponseSchema,
} from '../routes/journal.js';
import {
  kidLearnAnswerSchema,
  kidReadingCreateSchema,
  kidReadingPatchSchema,
} from '../routes/kid.js';
import {
  worldFlagsExploreBodySchema,
  worldFlagsLearnCompleteBodySchema,
} from '../lib/world-flags.js';
import { bookSchema, listBooksResponseSchema } from '../lib/reading-log-shared.js';
import { mwAnalyticsResponseSchema } from '../routes/mw-analytics.js';
import { listNoticesResponseSchema } from '../routes/notices.js';
import {
  createInvitationRequestSchema,
  createInvitationResponseSchema,
} from '../routes/invitations.js';
import { createTenantRequestSchema, createTenantResponseSchema } from '../routes/public-tenant.js';
import { slugAvailableResponseSchema } from '../routes/slug-available.js';
import { publicKidMembersResponseSchema } from '../routes/public-kid-members.js';
import { kidPinRequestSchema, kidPinResponseSchema } from '../routes/auth-kid-pin.js';
import { listMembersResponseSchema, setMemberPinResponseSchema } from '../routes/members.js';
import { listTasksResponseSchema } from '../routes/tasks.js';
import {
  createInvestmentRequestSchema,
  investmentSettingsRequestSchema,
  investmentRecordSchema,
} from '../routes/mw-financial.js';
import {
  difficultySchema,
  listLearnResponseSchema,
  lessonQuestionsResponseSchema,
  lessonAnswerResponseSchema,
  subtopicSchema,
} from '../lib/learn-shared.js';

export interface QueryParamMeta {
  description?: string;
  required?: boolean;
  schema: ZodTypeAny;
}

export interface RouteMeta {
  summary?: string;
  description?: string;
  request?: ZodTypeAny;
  response?: ZodTypeAny;
  responseDesc?: string;
  /** Set false to mark a route as not requiring the bearer token. */
  security?: false;
  /** Optional query parameters to document (name → meta). */
  queryParams?: Record<string, QueryParamMeta>;
}

export const routeMeta: Record<string, RouteMeta> = {
  'GET /health': { summary: 'Liveness probe', security: false },
  'GET /hello': { summary: 'Hello sanity check', security: false },

  'GET /api/me': {
    summary: 'The signed-in user + their families',
    response: meResponseSchema,
    responseDesc: 'The user and the tenants they belong to',
  },

  // Public / pre-tenant.
  'POST /api/public/tenant': {
    summary: 'Create a family (sign-up onboarding)',
    request: createTenantRequestSchema,
    response: createTenantResponseSchema,
    security: false,
  },
  'GET /api/public/slug-available': {
    summary: 'Check if a family URL slug is free',
    response: slugAvailableResponseSchema,
    security: false,
  },
  'GET /api/public/kid-members/{slug}': {
    summary: "List a family's kids who can log in with a PIN",
    response: publicKidMembersResponseSchema,
    security: false,
  },
  'POST /api/auth/kid-pin': {
    summary: 'Exchange a kid PIN for a kid session token',
    request: kidPinRequestSchema,
    response: kidPinResponseSchema,
    security: false,
  },

  // Kid-scoped (kid token).
  'GET /api/kid/me': { summary: 'The logged-in kid (token claims)', response: kidMeResponseSchema },
  'GET /api/kid/profile': {
    summary: "The kid's profile for the dashboard header (name, avatar, stars/cash)",
    response: kidProfileResponseSchema,
  },
  'GET /api/kid/tasks': { summary: "The kid's own tasks", response: kidTasksResponseSchema },
  'GET /api/kid/today': {
    summary: "The kid's own habits for today",
    response: kidTodayResponseSchema,
  },
  'GET /api/kid/weeks': {
    summary: "The kid's weeks (full shape, identical to parent GET /mw/weeks)",
    response: kidWeeksResponseSchema,
  },
  'GET /api/kid/weeks/{id}/stats': {
    summary: "Sticker counts + cash value for one of the kid's weeks",
    response: kidWeekStatsResponseSchema,
  },
  'GET /api/kid/weeks/{id}/actions': {
    summary: "Audit log of week actions for one of the kid's weeks",
  },
  'GET /api/kid/habits': {
    summary: "The kid's habits + stickers + balance (identical to parent GET /api/habits)",
    response: listHabitsResponseSchema,
  },
  'GET /api/kid/rewards': {
    summary: "The kid's reward shop + star balance + their latest request status per reward",
    response: kidRewardsResponseSchema,
  },
  'POST /api/kid/rewards/{id}/request': {
    summary: 'The kid asks to redeem a reward (no deduction; an admin approves)',
    response: kidRedemptionRequestSchema,
    responseDesc: 'The pending request row (idempotent — returns an existing pending one)',
  },
  'GET /api/kid/financial/savings': {
    summary: "The kid's banked savings + currency (identical to parent GET /mw/financial/savings)",
    response: kidSavingsResponseSchema,
  },
  'GET /api/kid/financial/investments': {
    summary:
      "The kid's active investments with live value (identical to parent GET /mw/financial/investments)",
    response: kidInvestmentsResponseSchema,
  },
  'GET /api/kid/meals': {
    summary: "The kid's meals (their own + family-wide)",
    response: listMealsResponseSchema,
  },
  'GET /api/kid/events': {
    summary: "The kid's schedule for a week (their own + family-wide)",
    response: listEventsResponseSchema,
  },
  'GET /api/kid/journal': {
    summary: "The kid's journal entry for a day (+ the day's quote)",
    response: journalDayResponseSchema,
  },
  'GET /api/kid/journal/entries': {
    summary: "The kid's past journal entries",
    response: journalEntriesResponseSchema,
  },
  'GET /api/kid/journal/earliest': {
    summary: "The kid's earliest journal date",
    response: journalEarliestResponseSchema,
  },
  'GET /api/kid/learn': {
    summary: "The kid's lesson subjects + progress",
    response: listLearnResponseSchema,
  },
  'GET /api/kid/learn/{subject}/questions': {
    summary: "Questions for the kid's lesson + their stats",
    response: lessonQuestionsResponseSchema,
    queryParams: {
      difficulty: { schema: difficultySchema, description: 'Lesson difficulty (default: easy)' },
      subtopic: {
        schema: subtopicSchema,
        description:
          'Logic sub-topic filter (patterns|odd-one-out|if-then|sorting). Logic only; ignored for other subjects.',
      },
    },
  },
  'POST /api/kid/learn/{subject}/answer': {
    summary: "Grade one of the kid's answers",
    request: kidLearnAnswerSchema,
    response: lessonAnswerResponseSchema,
  },
  'GET /api/kid/reading-log': {
    summary: "The kid's reading log",
    response: listBooksResponseSchema,
  },
  'POST /api/kid/reading-log': {
    summary: 'Add a book to the kid reading log',
    request: kidReadingCreateSchema,
    response: bookSchema,
  },
  'PATCH /api/kid/reading-log/{id}': {
    summary: 'Mark a kid book finished/unfinished',
    request: kidReadingPatchSchema,
    response: bookSchema,
  },
  'DELETE /api/kid/reading-log/{id}': { summary: 'Remove a book from the kid reading log' },
  'GET /api/kid/analytics': {
    summary: "The kid's My World analytics (stats view)",
    response: mwAnalyticsResponseSchema,
  },
  'GET /api/kid/world-flags': {
    summary: "The kid's explored country flags",
    response: kidWorldFlagsExploredResponseSchema,
    responseDesc: 'All country codes this kid has explored, in DB order',
  },
  'POST /api/kid/world-flags/explore': {
    summary: 'Mark a country flag as explored (idempotent)',
    request: worldFlagsExploreBodySchema,
    response: z.object({ explored: z.literal(true) }),
    responseDesc: '{ explored: true } — always, even if already recorded',
  },
  'GET /api/kid/world-flags/learn': {
    summary: "The kid's world-flags learn progress per continent",
    response: kidWorldFlagsLearnResponseSchema,
    responseDesc: 'Completed set indices per continent, each array sorted ascending',
  },
  'POST /api/kid/world-flags/learn-complete': {
    summary: 'Mark a learn-path set as mastered (idempotent)',
    request: worldFlagsLearnCompleteBodySchema,
    response: z.object({ completed: z.literal(true) }),
    responseDesc: '{ completed: true } — always, even if already recorded',
  },
  'GET /api/mw/analytics': {
    summary: "A child's My World analytics (parent view)",
    response: mwAnalyticsResponseSchema,
  },

  // My World investments (FHS-296 / FHS-378).
  'GET /api/mw/financial/investments': {
    summary: "A child's active investments with live value (?memberId=)",
    response: kidInvestmentsResponseSchema,
    responseDesc:
      'Each item carries `deductible` — false means missed days count but apply no penalty',
  },
  'POST /api/mw/financial/investments': {
    summary: 'Create an investment (optional `deductible`, default true)',
    request: createInvestmentRequestSchema,
    response: investmentRecordSchema,
    responseDesc: 'The created investment row',
  },
  'POST /api/mw/financial/investments/{id}/settings': {
    summary: "Toggle an active investment's deductible flag (FHS-378)",
    request: investmentSettingsRequestSchema,
    response: investmentRecordSchema,
    responseDesc: 'The updated investment row (404 if missing, 409 if not active)',
  },

  // Redemption requests (FHS-376) — kid asks, admin approves/declines.
  'GET /api/mw/redemption-requests': {
    summary: "The family's reward redemption requests (?status=pending|approved|declined)",
    response: listRedemptionRequestsResponseSchema,
  },
  'POST /api/mw/redemption-requests/{id}/approve': {
    summary: "Approve a request — admin only; deducts star_cost from the kid's savings",
    response: decideRedemptionRequestResponseSchema,
  },
  'POST /api/mw/redemption-requests/{id}/decline': {
    summary: 'Decline a request — admin only; no deduction',
    response: decideRedemptionRequestResponseSchema,
  },

  // Invitations.
  'POST /api/invitations': {
    summary: 'Invite someone to the family',
    request: createInvitationRequestSchema,
    response: createInvitationResponseSchema,
  },
  'POST /api/invitations/claim': { summary: 'Claim invites addressed to my email' },

  // Members.
  'GET /api/members': { summary: 'List family members', response: listMembersResponseSchema },
  'PUT /api/members/{id}/pin': {
    summary: "Set a kid member's login PIN",
    response: setMemberPinResponseSchema,
  },

  // Notices / tasks.
  'GET /api/notices': { summary: 'The family noticeboard', response: listNoticesResponseSchema },
  'GET /api/tasks': { summary: 'List tasks', response: listTasksResponseSchema },
};
