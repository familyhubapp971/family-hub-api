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

import type { ZodTypeAny } from 'zod';
import { meResponseSchema } from '../routes/me.js';
import {
  kidFinancialResponseSchema,
  kidMeResponseSchema,
  kidPlaceStickerSchema,
  kidProfileResponseSchema,
  kidRedeemResponseSchema,
  kidRemoveStickerSchema,
  kidTasksResponseSchema,
  kidTodayResponseSchema,
  kidWeeksResponseSchema,
} from '../routes/kid.js';
import { listHabitsResponseSchema } from '../routes/habits.js';
import { listRewardsResponseSchema } from '../routes/rewards.js';
import { listMealsResponseSchema } from '../routes/meals.js';
import { listEventsResponseSchema } from '../routes/events.js';
import {
  journalDayResponseSchema,
  journalEntriesResponseSchema,
  journalEarliestResponseSchema,
  journalEntrySchema,
} from '../routes/journal.js';
import {
  kidJournalUpsertSchema,
  kidLearnAnswerSchema,
  kidReadingCreateSchema,
  kidReadingPatchSchema,
} from '../routes/kid.js';
import { bookSchema, listBooksResponseSchema } from '../routes/reading-log.js';
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
  listLearnResponseSchema,
  lessonQuestionsResponseSchema,
  lessonAnswerResponseSchema,
  answerRequestSchema,
} from '../routes/learn.js';

export interface RouteMeta {
  summary?: string;
  description?: string;
  request?: ZodTypeAny;
  response?: ZodTypeAny;
  responseDesc?: string;
  /** Set false to mark a route as not requiring the bearer token. */
  security?: false;
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
  'GET /api/kid/notices': {
    summary: "The kid's family noticeboard",
    response: listNoticesResponseSchema,
  },
  'GET /api/kid/tasks': { summary: "The kid's own tasks", response: kidTasksResponseSchema },
  'GET /api/kid/today': {
    summary: "The kid's own habits for today",
    response: kidTodayResponseSchema,
  },
  'GET /api/kid/weeks': {
    summary: "The kid's weeks (for prev/next navigation)",
    response: kidWeeksResponseSchema,
  },
  'GET /api/kid/habits': {
    summary: "The kid's habits + this week's stickers + balance",
    response: listHabitsResponseSchema,
  },
  'POST /api/kid/habits/{id}/stickers': {
    summary: 'Place a sticker on today (kid)',
    request: kidPlaceStickerSchema,
  },
  'DELETE /api/kid/habits/{id}/stickers': {
    summary: "Remove today's sticker (kid)",
    request: kidRemoveStickerSchema,
  },
  'GET /api/kid/rewards': {
    summary: "The kid's reward shop + their star balance",
    response: listRewardsResponseSchema,
  },
  'POST /api/kid/rewards/{id}/redeem': {
    summary: 'Claim a reward with the kid’s own stars',
    response: kidRedeemResponseSchema,
  },
  'GET /api/kid/financial': {
    summary: "The kid's savings + active investments",
    response: kidFinancialResponseSchema,
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
  'PUT /api/kid/journal': {
    summary: "Save the kid's journal for a day",
    request: kidJournalUpsertSchema,
    response: journalEntrySchema,
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
  'GET /api/mw/analytics': {
    summary: "A child's My World analytics (parent view)",
    response: mwAnalyticsResponseSchema,
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

  // Learn — interactive lessons (FHS-283).
  'GET /api/learn/{subject}/questions': {
    summary: "Questions for a subject's lesson + the child's stats",
    response: lessonQuestionsResponseSchema,
  },
  'POST /api/learn/{subject}/answer': {
    summary: 'Grade one answer and update streak/score/progress',
    request: answerRequestSchema,
    response: lessonAnswerResponseSchema,
  },
};
