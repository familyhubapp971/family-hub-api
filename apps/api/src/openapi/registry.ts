// FHS-356: OpenAPI enrichment registry.
//
// Every endpoint is discovered automatically from the live Hono route table
// (see build-spec.ts), so the spec can never silently miss a route. This map
// only adds the human-friendly detail on top: a summary plus the request /
// response shape, reusing the SAME Zod schemas the handlers validate with: so
// the docs can't drift from the contract.
//
// Keyed by `${METHOD} ${openApiPath}` where openApiPath uses `{param}` (not
// Hono's `:param`). Endpoints not listed here still appear in the spec with an
// auto-generated summary and a generic 200 response: fill them in over time.

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
  kidAiMathLessonBodySchema,
  kidAiMathLessonResponseSchema,
  mathsPlacementResponseSchema,
  mathsCertResponseSchema,
  listMathsProgressResponseSchema,
  listMathsCertsResponseSchema,
  updateProgressBodySchema,
  placementBodySchema,
  certBodySchema,
  mathsProgressRowSchema,
} from '../routes/kid.js';
import {
  listHabitsResponseSchema,
  habitItemSchema,
  createHabitRequestSchema,
  updateHabitRequestSchema,
} from '../routes/habits.js';
import {
  decideRedemptionRequestResponseSchema,
  listRedemptionRequestsResponseSchema,
} from '../routes/mw-redemption-requests.js';
import { listMealsResponseSchema } from '../routes/meals.js';
import {
  createEventRequestSchema,
  eventItemSchema,
  listEventsResponseSchema,
} from '../routes/events.js';
import { calendarFeedResponseSchema } from '../routes/calendar.js';
import {
  journalDayResponseSchema,
  journalEntriesResponseSchema,
  journalEarliestResponseSchema,
} from '../routes/journal.js';
import {
  kidLearnAnswerSchema,
  kidReadingCreateSchema,
  kidReadingPatchSchema,
  logicQuestionsResponseSchema,
  logicAnswerResponseSchema,
  logicCertificatesResponseSchema,
} from '../routes/kid.js';
import { answerBodySchema as logicAnswerBodySchema } from '../lib/logic-progress.js';
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
import {
  addMemberBodySchema,
  addMemberResponseSchema,
  confirmEmailChangeBodySchema,
  confirmEmailChangeResponseSchema,
  listMembersResponseSchema,
  memberEmailChangeRequestBodySchema,
  memberEmailChangeRequestResponseSchema,
  setMemberPinResponseSchema,
} from '../routes/members.js';
import { listTasksResponseSchema } from '../routes/tasks.js';
import {
  createInvestmentRequestSchema,
  investmentSettingsRequestSchema,
  investmentRecordSchema,
  saveSchema,
  cashoutSchema,
  savingsMutationResponseSchema,
  adminSetSavingsRequestSchema,
  withdrawInvestmentRequestSchema,
} from '../routes/mw-financial.js';
import {
  weeksResponseSchema,
  weekResponseSchema,
  weekStatsResponseSchema,
  weekActionsResponseSchema,
  memberBodySchema,
  finalizeRequestSchema,
  weekCashRequestSchema,
} from '../routes/mw-weeks.js';
import {
  difficultySchema,
  listLearnResponseSchema,
  lessonQuestionsResponseSchema,
  lessonAnswerResponseSchema,
  subtopicSchema,
} from '../lib/learn-shared.js';
import { learnInsightsResponseSchema } from '../routes/learn-insights.js';
import { feedbackRequestSchema, feedbackResponseSchema } from '../routes/feedback.js';
import {
  publicFeedbackRequestSchema,
  publicFeedbackResponseSchema,
} from '../routes/public-feedback.js';
import {
  adminSettingsResponseSchema,
  adminSettingsPutRequestSchema,
  adminSettingsPutResponseSchema,
  adminExportResponseSchema,
  adminDeleteAccountRequestSchema,
  adminDeleteAccountResponseSchema,
} from '../routes/admin.js';
import {
  rewardItemSchema,
  createRewardRequestSchema,
  updateRewardRequestSchema,
} from '../routes/rewards.js';
import {
  rewardConfigResponseSchema,
  rewardConfigPutRequestSchema,
} from '../routes/reward-config.js';
import { getStartedDismissResponseSchema, getStartedStateSchema } from '@familyhub/shared';

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
    responseDesc: 'The pending request row (idempotent: returns an existing pending one)',
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

  // Calendar activities (FHS-230, FHS-265, FHS-476).
  'GET /api/events': {
    summary: "The family's calendar activities for a week (?weekStart=YYYY-MM-DD)",
    response: listEventsResponseSchema,
    responseDesc:
      'One entry per occurrence in the 7-day window. A weekly-recurring series (recurrenceDays set) contributes one entry per matching weekday, all sharing the same series id, with isRecurring: true',
    queryParams: {
      weekStart: {
        description: 'Monday of the week to fetch (YYYY-MM-DD)',
        required: true,
        schema: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      },
    },
  },
  'POST /api/events': {
    summary: 'Create a calendar activity; admin/adult only',
    description:
      'Optional recurrenceDays (weekdays 0=Sun..6=Sat) + recurrenceEndDate turn it into a weekly-repeating series anchored on `date`. No occurrence rows are stored: GET expands the series on read.',
    request: createEventRequestSchema,
    response: eventItemSchema,
    responseDesc: '201: the created event (the series anchor, if recurring)',
  },
  'PUT /api/events/{id}': {
    summary: 'Replace an event (full update); admin/adult only',
    description:
      'For a recurring series this edits the WHOLE series (start date, weekdays, end date, and all other fields): not a single occurrence. Single-occurrence editing is a follow-up.',
    request: createEventRequestSchema,
    response: eventItemSchema,
  },
  'DELETE /api/events/{id}': {
    summary: 'Delete an event; admin/adult only',
    responseDesc:
      '204 on success. For a recurring series this deletes the WHOLE series. 404 if not found in this tenant',
  },
  'GET /api/calendar/feed': {
    summary: 'The family calendar subscribe URL (creates the feed key on first call)',
    response: calendarFeedResponseSchema,
    responseDesc: 'An absolute ICS subscribe URL for Google / Apple / Outlook',
  },
  'POST /api/calendar/feed/rotate': {
    summary: 'Regenerate the calendar feed key (admin-only); invalidates old subscriptions',
    response: calendarFeedResponseSchema,
  },
  'GET /api/public/calendar/{token}': {
    summary: 'Public ICS calendar feed for a family (signed token = credential)',
    security: false,
    responseDesc: 'text/calendar (ICS) of the family activities',
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
    responseDesc: '{ explored: true }: always, even if already recorded',
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
    responseDesc: '{ completed: true }: always, even if already recorded',
  },
  // FHS-389: AI Maths lesson (feature-flagged OFF by default).
  'GET /api/kid/learn/maths/ai-lesson/status': {
    summary: 'Whether AI Maths lessons are enabled (cheap probe, no generation)',
    response: z.object({ enabled: z.boolean() }),
  },
  'POST /api/kid/learn/maths/ai-lesson': {
    summary: 'Generate an AI Maths lesson for the kid (feature-flagged)',
    request: kidAiMathLessonBodySchema,
    response: kidAiMathLessonResponseSchema,
    responseDesc:
      '{ enabled: false } when the flag is off; { enabled: true, lesson } on success; { enabled: true, lesson: null, error } on AI failure',
  },
  // FHS-384: Learn Insights (parent view of one child's learning progress).
  'GET /api/learn/insights': {
    summary: "A child's Learn insights across Maths, Logic, Science, and World Flags (parent view)",
    response: learnInsightsResponseSchema,
    responseDesc:
      'Aggregated insights for the requested child. hasActivity: false when the child has no Learn activity at all.',
    queryParams: {
      memberId: {
        description: 'UUID of the child member to query (must belong to the same family)',
        required: true,
        schema: z.string().uuid(),
      },
    },
  },

  'GET /api/mw/analytics': {
    summary: "A child's My World analytics (parent view)",
    response: mwAnalyticsResponseSchema,
  },

  // FHS-418: Beta feedback (authenticated, tenant-scoped).
  'POST /api/feedback': {
    summary: 'Submit a beta survey response',
    description:
      'Authenticated users submit product feedback. All fields are optional but at least one must be present.',
    request: feedbackRequestSchema,
    response: feedbackResponseSchema,
    responseDesc: '201: the new feedback row id',
  },

  // FHS-429: Public (anonymous) feedback from the logged-out homepage.
  'POST /api/public/feedback': {
    summary: 'Submit anonymous homepage feedback',
    description:
      'Unauthenticated visitors submit product feedback from the public homepage. All fields optional but at least one survey field (not just name/email) must be present.',
    request: publicFeedbackRequestSchema,
    response: publicFeedbackResponseSchema,
    responseDesc: '201: the new public_feedback row id',
    security: false,
  },

  // My World savings (FHS-606): the Your Savings card's split.
  'GET /api/mw/financial/savings': {
    summary: "A child's banked savings, split into last week's banking and earlier (?memberId=)",
    response: kidSavingsResponseSchema.extend({
      earnedLastWeekStickers: z.number().int(),
      keptFromEarlierStickers: z.number().int(),
    }),
    responseDesc: 'earnedLastWeekStickers + keptFromEarlierStickers always equals savedStickers',
  },

  // FHS-627: the rest of the money endpoints. Each summary says who may call
  // it, so the next reader does not have to trace the guards to find out.
  'POST /api/mw/financial/savings': {
    summary:
      "Bank this week's spare stickers, as stickers or as cash. Any grown-up, or the child themself",
    request: saveSchema,
    response: savingsMutationResponseSchema,
    responseDesc:
      "Banks at most what is spare this week. Asking for cash converts at the child's own sticker rate",
  },
  'POST /api/mw/financial/savings/cashout': {
    summary: 'Turn banked savings into real money. Any grown-up, or the child themself',
    request: cashoutSchema,
    response: savingsMutationResponseSchema,
    responseDesc: '409 when the child does not have that much saved',
  },
  'PUT /api/mw/financial/savings/admin-set': {
    summary: "Set a child's balance by hand, overwriting what is there. ADMIN ONLY",
    request: adminSetSavingsRequestSchema,
    response: savingsMutationResponseSchema,
    responseDesc: 'Writes the figures as given. Use to correct a mistake, not for everyday moves',
  },
  'POST /api/mw/financial/investments/{id}/withdraw': {
    summary:
      'Take stickers back out of a running investment, all or part. Any grown-up, or the child themself',
    request: withdrawInvestmentRequestSchema,
    response: savingsMutationResponseSchema,
    responseDesc:
      'Omit `stickers` to take the lot. What comes out goes to savings; the rest keeps growing',
  },

  // FHS-627: the week endpoints. Every one of these was listed with nothing
  // said about it, and they are what a finished week's record is built from.
  'GET /api/mw/weeks': {
    summary:
      'Every week for a child, oldest first (?memberId=). Any grown-up, or the child themself',
    response: weeksResponseSchema,
    responseDesc: 'Creates the current week if it does not exist yet, so the list is never empty',
  },
  'GET /api/mw/weeks/current': {
    summary:
      "The child's open week, creating it if needed (?memberId=). Any grown-up, or the child themself",
    response: weekResponseSchema,
  },
  'GET /api/mw/weeks/{id}/stats': {
    summary:
      "One week's sticker counts and what they are worth (?memberId=). Any grown-up, or the child themself",
    response: weekStatsResponseSchema,
    responseDesc: 'unallocatedStickers is what is still spare; allocatedStickers is what has moved',
  },
  'GET /api/mw/weeks/{id}/actions': {
    summary:
      "Everything that happened to a week's stickers, newest first (?memberId=). Any grown-up, or the child themself",
    response: weekActionsResponseSchema,
    responseDesc:
      "This is the record a finished week is summarised from. `invest_continue` carries a running investment's WHOLE value, not new money (FHS-617)",
  },
  'POST /api/mw/weeks/{id}/finalize': {
    summary: 'Close a week and start the next one. ADMIN ONLY',
    request: finalizeRequestSchema,
    responseDesc:
      'Banks anything spare, settles investments, applies skip penalties, and carries the rest forward. Name the investments to keep running in continueInvestmentIds',
  },
  'POST /api/mw/weeks/{id}/reopen': {
    summary: 'Undo a close, putting the week back as it was. ADMIN ONLY',
    request: memberBodySchema,
    responseDesc: 'Reverses what the close did: banking, investment settlement and any penalty',
  },
  'POST /api/mw/weeks/{id}/repair': {
    summary: 'Clear leftover close effects from a week that is still open. ADMIN ONLY',
    request: memberBodySchema,
    responseDesc: 'For a week left half-closed by an interrupted finalize',
  },
  'PUT /api/mw/weeks/{id}/cash': {
    summary: "Correct a week's carried and retrieved cash by hand. ADMIN ONLY",
    request: weekCashRequestSchema,
    responseDesc: 'Neither figure may be negative',
  },

  // My World investments (FHS-296 / FHS-378).
  'GET /api/mw/financial/investments': {
    summary: "A child's active investments with live value (?memberId=)",
    response: kidInvestmentsResponseSchema,
    responseDesc:
      'Each item carries `deductible`: false means missed days count but apply no penalty',
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

  // Redemption requests (FHS-376): kid asks, admin approves/declines.
  'GET /api/mw/redemption-requests': {
    summary: "The family's reward redemption requests (?status=pending|approved|declined)",
    response: listRedemptionRequestsResponseSchema,
  },
  'POST /api/mw/redemption-requests/{id}/approve': {
    summary: "Approve a request: admin only; deducts star_cost from the kid's savings",
    response: decideRedemptionRequestResponseSchema,
  },
  'POST /api/mw/redemption-requests/{id}/decline': {
    summary: 'Decline a request: admin only; no deduction',
    response: decideRedemptionRequestResponseSchema,
  },

  // Invitations.
  'POST /api/invitations': {
    summary: 'Invite someone to the family',
    description:
      "role is one of admin | adult | teen | guest (default adult). Granting 'admin' " +
      'requires the caller to already be an admin (403 otherwise): FHS-486 / ADR 0019.',
    request: createInvitationRequestSchema,
    response: createInvitationResponseSchema,
  },
  'POST /api/invitations/claim': { summary: 'Claim invites addressed to my email' },

  // Members.
  'GET /api/members': {
    summary: 'List family members',
    response: listMembersResponseSchema,
    responseDesc:
      "email and pendingEmail (FHS-510) are admin-only: a non-admin caller always gets null on both, regardless of the member's actual state.",
  },
  'POST /api/members': {
    summary: 'Add a family member seat (child, teen, or adult): no login, direct roster insert',
    request: addMemberBodySchema,
    response: addMemberResponseSchema,
  },
  'PUT /api/members/{id}/pin': {
    summary: "Set a kid member's login PIN",
    response: setMemberPinResponseSchema,
  },

  // FHS-510: admin-initiated sign-in email change, confirmed by a one-time link.
  'POST /api/members/{id}/email-change': {
    summary: "Start changing a grown-up member's sign-in email; admin-only",
    description:
      'Emails a one-time confirm link to the NEW address, plus a best-effort heads-up notice to the OLD address (never blocks this response). The old address keeps working until the link is clicked. 400 NO_LOGIN_EMAIL if the target has no linked login; 409 if the new email already belongs to a Family Hub account, or if a concurrent request for the same member won the race.',
    request: memberEmailChangeRequestBodySchema,
    response: memberEmailChangeRequestResponseSchema,
    responseDesc: '{ pendingEmail }: the address the confirm link was sent to',
  },
  'POST /api/members/{id}/email-change/cancel': {
    summary: 'Cancel a pending email change for a member; admin-only',
    responseDesc: '{ cancelled: true }: always 200, even if there was nothing pending',
  },
  'POST /api/members/email-change/confirm': {
    summary: 'Apply a pending email change from the emailed confirm link',
    description:
      'PUBLIC: the recipient may not be signed in. The token is the credential (its SHA-256 hash is matched server-side); single-use and expires 24h after the admin started the change. Sends a best-effort completion notice to the OLD address on success (never blocks this response). The web ConfirmEmail screen requires an explicit click before calling this: it never auto-fires on page load, so an email link-scanner prefetch cannot burn the token.',
    request: confirmEmailChangeBodySchema,
    response: confirmEmailChangeResponseSchema,
    responseDesc:
      '200 on success. 410 { error: "expired" } if the link is missing/used/expired: the recipient should ask an admin for a new one. 502/500 { errorCode: "EMAIL_CHANGE_APPLY_FAILED" } on a transient failure (Supabase hiccup, or a post-apply drift): the token may still be valid, so the caller should retry rather than treat it as expired.',
    security: false,
  },

  // Notices / tasks.
  'GET /api/notices': { summary: 'The family noticeboard', response: listNoticesResponseSchema },
  'GET /api/tasks': { summary: 'List tasks', response: listTasksResponseSchema },

  // FHS-394: Kid Maths progression.
  'GET /api/kid/maths/progress': {
    summary: 'All maths progress rows for this kid (all operations + tables)',
    response: listMathsProgressResponseSchema,
    responseDesc: 'Every (operation, table_number) row the kid has touched, in DB order',
  },
  'PUT /api/kid/maths/progress': {
    summary: 'Upsert one maths progress row: only supplied fields are updated',
    request: updateProgressBodySchema,
    response: mathsProgressRowSchema,
    responseDesc: 'The upserted row after the update',
  },
  'POST /api/kid/maths/placement': {
    summary: 'Apply placement test results and auto-master qualifying tables',
    request: placementBodySchema,
    response: mathsPlacementResponseSchema,
    responseDesc:
      'unlocked[]: the table numbers newly mastered by this call (already-mastered tables are excluded)',
  },
  'GET /api/kid/maths/certificates': {
    summary: 'All earned maths certificates for this kid',
    response: listMathsCertsResponseSchema,
    responseDesc:
      'Certificates in DB order; difficulty is the table number string or easy/medium/hard',
  },
  'POST /api/kid/maths/certificates': {
    summary: 'Award a certificate (idempotent: returns existing if already earned)',
    request: certBodySchema,
    response: mathsCertResponseSchema,
    responseDesc: '{ certificate, alreadyEarned }: 200 if already earned, 201 if newly created',
  },

  // FHS-395: Kid Logic progression.
  'GET /api/kid/logic/questions': {
    summary: 'Questions for a logic game-type × difficulty combo (answers stripped)',
    response: logicQuestionsResponseSchema,
    responseDesc: 'questions[]: type-specific fields for the renderer; correct answer not included',
    queryParams: {
      gameType: {
        description: 'One of: truefalse, patterns, oddoneout, ifthen, sorting',
        required: true,
        schema: logicAnswerBodySchema.shape.gameType,
      },
      difficulty: {
        description: 'One of: easy, medium, hard',
        required: true,
        schema: logicAnswerBodySchema.shape.difficulty,
      },
    },
  },
  'POST /api/kid/logic/answer': {
    summary: 'Grade a logic answer server-side; award certificate at 10 correct per combo',
    request: logicAnswerBodySchema,
    response: logicAnswerResponseSchema,
    responseDesc:
      '{ correct, correctAnswer, explanation, comboCorrect, certificateEarned }: comboCorrect is the running total for this gameType×difficulty',
  },
  'GET /api/kid/logic/certificates': {
    summary: 'All earned logic certificates for this kid',
    response: logicCertificatesResponseSchema,
    responseDesc:
      'certificates[]: one row per gameType×difficulty where the kid reached 10 correct answers',
  },

  // Admin Panel: App Info settings (FHS-308, FHS-441).
  'GET /api/admin/settings': {
    summary: "The family's app_settings map, plus its currency under the `currency` key",
    response: adminSettingsResponseSchema,
    responseDesc:
      '{ [key]: value }: includes appName/appSubtitle (if set) and always includes currency (from tenants.currency, default USD)',
  },
  // FHS-626: the family name is a real column, not a loose setting, so it is
  // called out rather than left inside the generic key description.
  'PUT /api/admin/settings/familyName': {
    summary: "Rename the family. ADMIN ONLY. Never changes the family's web address",
    request: z.object({ value: z.string().min(1).max(80) }),
    response: z.object({ key: z.literal('familyName'), value: z.string() }),
    responseDesc: 'A blank name is refused. The slug the family lives at is untouched',
  },
  'PUT /api/admin/settings/{key}': {
    summary: 'Upsert one setting; admin-only. `currency` writes tenants.currency, not app_settings',
    request: adminSettingsPutRequestSchema,
    response: adminSettingsPutResponseSchema,
    responseDesc:
      'For key=currency: { key, value } where value is the 3-letter ISO 4217 code just saved. Otherwise the upserted app_settings row',
  },

  // My World habits: FHS-292, boost + skip-penalty fields added FHS-512.
  'GET /api/habits': {
    summary: "A member's habits + this week's stickers + spendable balance",
    response: listHabitsResponseSchema,
    responseDesc:
      'habits[] (each carries boost + skipPenaltyMinor), stickers[], week, balance, currency',
  },
  'POST /api/habits': {
    summary: 'Create a habit for a member; admin-only',
    request: createHabitRequestSchema,
    response: habitItemSchema,
    responseDesc:
      'boost (1=normal, 2/3/5=boosted) sets the stickerValue a completion places; skipPenaltyMinor (integer minor units) is deducted at close-week for a due day missed',
  },
  'PUT /api/habits/{id}': {
    summary: 'Update a habit (name/icon/color/boost/skipPenaltyMinor); admin-only',
    request: updateHabitRequestSchema,
    response: habitItemSchema,
  },

  // FHS-512: configurable reward economy ("Pocket money" settings screen).
  'GET /api/reward-config': {
    summary: "The family's sticker rate + each kid's rate override",
    response: rewardConfigResponseSchema,
    responseDesc:
      'currency, familyRateMinor (integer minor units, e.g. 50 = 0.50), and members[]: one row per kid with rateMinor (their override, null = uses the family default) and effectiveRateMinor (the resolved rate actually used)',
  },
  'PUT /api/reward-config': {
    summary:
      "Update the family's default sticker rate and/or one or more kids' overrides; admin-only",
    request: rewardConfigPutRequestSchema,
    response: rewardConfigResponseSchema,
    responseDesc:
      'The updated config, same shape as GET. Unknown/foreign memberIds in memberOverrides are silently skipped',
  },

  // GDPR: export my data + delete my account (FHS-435).
  'GET /api/admin/export': {
    summary: "Download the family's full data as one JSON file (GDPR data portability); admin-only",
    response: adminExportResponseSchema,
    responseDesc:
      'Content-Disposition: attachment. { exportedAt, family, data }: data has one array per tenant-scoped table (e.g. members, tasks, habits, habitStickers), each row filtered to this tenant only',
  },
  'POST /api/admin/delete-account': {
    summary: "IRREVERSIBLE: permanently deletes the caller's family and all its data; admin-only",
    request: adminDeleteAccountRequestSchema,
    response: adminDeleteAccountResponseSchema,
    responseDesc:
      '{ deleted: true } on success. 400 CONFIRM_MISMATCH if `confirm` does not exactly equal the family name: nothing is deleted in that case',
  },

  // FHS-483: parent-managed reward-shop catalogue (create/edit/archive).
  'POST /api/rewards': {
    summary: 'Create a reward in the family reward shop; admin-only',
    request: createRewardRequestSchema,
    response: rewardItemSchema,
    responseDesc: '201: the created reward',
  },
  'PATCH /api/rewards/{id}': {
    summary: "Partially update a reward's name/description/stickerCost/icon; admin-only",
    request: updateRewardRequestSchema,
    response: rewardItemSchema,
    responseDesc: "The updated reward. 404 if the reward is not in the caller's tenant",
  },
  'DELETE /api/rewards/{id}': {
    summary: 'Archive (soft-delete) a reward; admin-only',
    responseDesc:
      "204 on success. 404 if the reward is not in the caller's tenant or is already archived. Never a hard delete: reward_redemptions/redemption_requests keep their FK for history",
  },

  // FHS-634: the dashboard "Getting started" guide, stored per member so it
  // stops re-appearing on every new browser.
  'GET /api/onboarding/get-started': {
    summary: 'State of the dashboard setup guide for the calling admin',
    response: getStartedStateSchema,
    responseDesc:
      'dismissed (this member hid the guide), steps.{kids,pins,rate,habits} derived from the family\'s own data, and firstKidId for the "open their world" deep link. 403 for non-admins',
  },
  'POST /api/onboarding/get-started/dismiss': {
    summary: 'Hide the dashboard setup guide for the calling admin, on every device',
    response: getStartedDismissResponseSchema,
    responseDesc:
      'Always { dismissed: true }. Idempotent: a repeat call keeps the original timestamp. 403 for non-admins',
  },
};
