// FHS-664: OpenAPI entries for the planner endpoints. See ../registry.ts.
import { z } from 'zod';
import type { RouteMeta } from '../registry.js';
import {
  DATE_RE,
  journalEntrySchema,
  journalDayResponseSchema,
  journalEntriesResponseSchema,
  journalEarliestResponseSchema,
  journalContentResponseSchema,
  upsertRequestSchema as journalUpsertRequestSchema,
} from '../../routes/journal.js';
import {
  listMealsResponseSchema,
  mealCellSchema,
  upsertMealRequestSchema,
} from '../../routes/meals.js';
import { noticeItemSchema, createNoticeRequestSchema } from '../../routes/notices.js';
import { eventItemSchema, createEventRequestSchema } from '../../routes/events.js';
import { calendarFeedResponseSchema } from '../../routes/calendar.js';

const memberIdQueryParam = {
  description: 'UUID of the member whose journal is being read',
  required: true,
  schema: z.string().uuid(),
};

export const plannerMeta: Record<string, RouteMeta> = {
  // Journal (FHS-270): one row per (tenant, member, calendar day). Every
  // route below is scoped by canManage: the member themself, or an admin/adult.
  'GET /api/journal': {
    summary:
      "A member's journal entry for one day, plus that day's quote index; the member themself, or an admin/adult",
    response: journalDayResponseSchema,
    responseDesc:
      'entry is null if nothing was saved for that day; quoteIndex is always computed from the date. 404 if memberId is not in this tenant; 403 if the caller may not view this member',
    queryParams: {
      memberId: memberIdQueryParam,
      date: {
        description: 'The calendar day to fetch (YYYY-MM-DD, must be a real date)',
        required: true,
        schema: z.string().regex(DATE_RE),
      },
    },
  },
  'PUT /api/journal': {
    summary:
      "Create or update a member's journal entry for one day (upsert); the member themself, or an admin/adult",
    description:
      'quoteIndex is computed server-side from entryDate: the caller cannot set it. Keyed on (tenantId, memberId, entryDate), so a repeat call for the same day overwrites rather than duplicates.',
    request: journalUpsertRequestSchema,
    response: journalEntrySchema,
    responseDesc: 'The saved entry, after the upsert. 404 if memberId is not in this tenant',
  },
  'GET /api/journal/content': {
    summary: 'Static journal reference data: quotes, creativity prompts, and moods',
    description: 'No member scope: the same content for every member in the signed-in family.',
    response: journalContentResponseSchema,
  },
  'GET /api/journal/earliest': {
    summary:
      "A member's earliest journal date, for the back-navigation lower bound; the member themself, or an admin/adult",
    response: journalEarliestResponseSchema,
    responseDesc:
      'earliestDate is null if the member has never saved an entry. 404 if memberId is not in this tenant',
    queryParams: { memberId: memberIdQueryParam },
  },
  'GET /api/journal/entries': {
    summary:
      "All of a member's past journal entries, newest first; the member themself, or an admin/adult",
    response: journalEntriesResponseSchema,
    responseDesc: '404 if memberId is not in this tenant',
    queryParams: { memberId: memberIdQueryParam },
  },

  // Meals (FHS-229, FHS-264): the family's repeating weekly meal-plan template.
  'GET /api/meals': {
    summary: "The family's weekly meal plan (every planned meal slot)",
    response: listMealsResponseSchema,
    responseDesc:
      'One row per planned (dayOfWeek, slot[, member]) cell; memberId null means the whole family',
  },
  'POST /api/meals': {
    summary: 'Upsert or clear one meal-plan cell (dayOfWeek + slot [+ member]); admin/adult only',
    description:
      'An empty/whitespace-only name deletes that cell instead of saving it, so the UI can clear a slot with the same endpoint. A (day, slot) can hold one whole-family meal (memberId: null) plus one per member, keyed on both.',
    request: upsertMealRequestSchema,
    response: z.union([mealCellSchema, z.object({ deleted: z.literal(true) })]),
    responseDesc:
      '{ deleted: true } when the name was blank (the cell was removed); otherwise the upserted meal cell. 400 if memberId is not a member of this tenant',
  },

  // Notices (FHS-232): the family noticeboard. GET is documented correctly
  // in the base registry already; only the write routes needed filling in.
  'POST /api/notices': {
    summary: 'Post a notice to the family noticeboard; admin/adult only',
    request: createNoticeRequestSchema,
    response: noticeItemSchema,
    status: 201,
    responseDesc:
      "201: the created notice. authorMemberId/authorName identify the poster (the caller's own member row)",
  },
  'PUT /api/notices/{id}': {
    summary: "Edit a notice's body/pinned/icon; admin/adult only",
    description: 'Authorship is never reassigned: authorMemberId always stays the original poster.',
    request: createNoticeRequestSchema,
    response: noticeItemSchema,
    responseDesc: "The updated notice. 404 if the notice is not in the caller's tenant",
  },
  'DELETE /api/notices/{id}': {
    summary: 'Delete a notice; admin/adult only',
    status: 204,
    responseDesc: "204 on success. 404 if the notice is not in the caller's tenant",
  },

  // Calendar activities (FHS-230, FHS-476): correcting two base entries that
  // were missing their real success status code.
  'POST /api/events': {
    summary: 'Create a calendar activity; admin/adult only',
    description:
      'Optional recurrenceDays (weekdays 0=Sun..6=Sat) + recurrenceEndDate turn it into a weekly-repeating series anchored on `date`. No occurrence rows are stored: GET expands the series on read.',
    request: createEventRequestSchema,
    response: eventItemSchema,
    status: 201,
    responseDesc: '201: the created event (the series anchor, if recurring)',
  },
  'DELETE /api/events/{id}': {
    summary: 'Delete an event; admin/adult only',
    status: 204,
    responseDesc:
      '204 on success. For a recurring series this deletes the WHOLE series. 404 if not found in this tenant',
  },

  // Calendar sync (FHS-445): subscribe-URL management + the public ICS feed.
  'POST /api/calendar/feed/rotate': {
    summary: 'Regenerate the calendar feed key (admin-only); invalidates old subscriptions',
    bodyless: true,
    response: calendarFeedResponseSchema,
    responseDesc:
      'The new subscribe URL. Every previously issued URL (old key) 404s from the public feed endpoint from this point on',
  },
  'GET /api/public/calendar/{token}': {
    summary:
      'Public ICS calendar feed for one family, for Google/Apple/Outlook (signed token = credential, no sign-in)',
    description:
      'Parses and verifies the signed token before touching any event row; every failure (bad signature, rotated-out key, unknown tenant) returns the same bare 404, so the endpoint never reveals which families exist. Only includes events from the last 90 days onward; future events are unbounded.',
    responseDesc:
      'Body is raw ICS text (Content-Type: text/calendar), not JSON: Content-Disposition: inline; filename="familyhub.ics", Cache-Control: private, max-age=300',
    responseContentType: 'text/calendar',
  },
};
