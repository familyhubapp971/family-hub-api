// FHS-664: OpenAPI entries for the tasks-habits endpoints. See ../registry.ts.
import { z } from 'zod';
import type { RouteMeta } from '../registry.js';
import {
  assignmentItemSchema,
  listAssignmentsResponseSchema,
  createAssignmentRequestSchema,
  patchAssignmentRequestSchema,
} from '../../routes/assignments.js';
import {
  taskItemSchema,
  createTaskRequestSchema,
  patchTaskRequestSchema,
} from '../../routes/tasks.js';
import {
  habitItemSchema,
  stickerItemSchema,
  listHabitsResponseSchema,
  createHabitRequestSchema,
  deleteSchema as deleteHabitBodySchema,
  placeStickerSchema,
  removeStickerSchema,
} from '../../routes/habits.js';
import { dashboardTodayResponseSchema } from '@familyhub/shared';

export const tasksHabitsMeta: Record<string, RouteMeta> = {
  // Assignments (FHS-231): the family homework/chore board. Any member can
  // read; only admins and adults can add/edit (distinct from /api/tasks,
  // which is private-to-edit).
  'GET /api/assignments': {
    summary: "List the family's assignments (homework/chores); any member",
    description:
      'Ordered by due date ascending (undated last), then created_at: open/overdue assignments sit on top, undated ones trail behind.',
    response: listAssignmentsResponseSchema,
  },
  'POST /api/assignments': {
    summary: 'Create an assignment; admin/adult only',
    request: createAssignmentRequestSchema,
    response: assignmentItemSchema,
    status: 201,
    responseDesc: '201: the created assignment',
  },
  'PATCH /api/assignments/{id}': {
    summary: 'Toggle an assignment done/not-done; admin/adult only',
    description: '`done: true` stamps doneAt to now; `false` clears it.',
    request: patchAssignmentRequestSchema,
    response: assignmentItemSchema,
    responseDesc: '404 if the assignment is not in this tenant',
  },
  'PUT /api/assignments/{id}': {
    summary: "Replace an assignment's title/notes/dueDate/assignee; admin/adult only",
    description:
      'Completion state (done/doneAt) is owned by PATCH and left untouched here, so editing a done assignment keeps it done.',
    request: createAssignmentRequestSchema,
    response: assignmentItemSchema,
    responseDesc: '404 if the assignment is not in this tenant',
  },

  // Tasks (FHS-233/FHS-267): shared-to-see, private-to-edit (ADR 0013). GET
  // is documented in baseMeta already and is correct; these are the
  // owner-scoped writes.
  'POST /api/tasks': {
    summary: 'Create a task for myself; any member',
    description: 'Always owned by the caller: memberId comes from the session, never the body.',
    request: createTaskRequestSchema,
    response: taskItemSchema,
    status: 201,
    responseDesc: '201: the created task',
  },
  'PATCH /api/tasks/{id}': {
    summary: 'Tick/untick one of my own tasks; any member',
    description:
      "Owner-scoped: a member can only mutate their own tasks. 404 covers both wrong-owner and not-found, by design, so a probe can't enumerate another member's task ids.",
    request: patchTaskRequestSchema,
    response: taskItemSchema,
  },
  'PUT /api/tasks/{id}': {
    summary: "Replace one of my own tasks' title/dueDate; any member",
    description:
      'Owner-scoped, same WHERE as PATCH/DELETE. memberId and completion state (doneAt) are not editable here.',
    request: createTaskRequestSchema,
    response: taskItemSchema,
  },
  'DELETE /api/tasks/{id}': {
    summary: 'Delete one of my own tasks; any member',
    status: 204,
    responseDesc: "204 on success. 404 if the task is not the caller's own",
  },

  // Habits (FHS-292, FHS-512): My World weekly typed-sticker grid.
  // FHS-664: GET was missing its query parameters (memberId required,
  // weekId optional); corrected here.
  'GET /api/habits': {
    summary: "A member's habits + this week's stickers + spendable balance",
    response: listHabitsResponseSchema,
    responseDesc:
      'habits[] (each carries boost + skipPenaltyMinor), stickers[], week, balance, currency',
    queryParams: {
      memberId: {
        description: 'UUID of the member whose habits/stickers to fetch',
        required: true,
        schema: z.string().uuid(),
      },
      weekId: {
        description:
          'A specific week id to view (FHS-293 navigation); defaults to, and falls back to, the current open week if not found',
        schema: z.string().uuid(),
      },
    },
  },
  // FHS-664: the handler replies 201 on create; baseMeta had no `status`,
  // which defaults to 200, so it was documenting the wrong code.
  'POST /api/habits': {
    summary: 'Create a habit for a member; admin-only',
    request: createHabitRequestSchema,
    response: habitItemSchema,
    status: 201,
    responseDesc:
      '201: the created habit. boost (1=normal, 2/3/5=boosted) sets the stickerValue a completion places; skipPenaltyMinor (integer minor units) is deducted at close-week for a due day missed',
  },
  'DELETE /api/habits/{id}': {
    summary: 'Delete a habit (its stickers cascade); admin-only',
    description:
      'memberId in the body scopes the delete, so a caller cannot delete another child’s habit.',
    request: deleteHabitBodySchema,
    status: 204,
    responseDesc: '204 on success. 404 if the habit is not found for that member',
  },
  'POST /api/habits/{id}/stickers': {
    summary: 'Place a typed sticker on a habit day for a week',
    description:
      'Any grown-up, or the member themself. Editing a past day, or any day in a finalized week, is admin-only (FHS-335). stickerValue is derived from the habit’s boost, not the request.',
    request: placeStickerSchema,
    response: stickerItemSchema,
    responseDesc: 'The upserted (habitId, day, week) sticker row',
  },
  'DELETE /api/habits/{id}/stickers': {
    summary: 'Remove a sticker from a habit day for a week',
    description:
      'Any grown-up, or the member themself. Removing a past day, or any day in a finalized week, is admin-only (FHS-335).',
    request: removeStickerSchema,
    status: 204,
    responseDesc: '204 on success, even if there was nothing there to remove',
  },

  // Dashboard (FHS-228/FHS-262/FHS-306/FHS-439/FHS-463): the Today tab's
  // single-round-trip bundle.
  'GET /api/dashboard/today': {
    summary: 'Everything the Today/Dashboard tab renders, in one round-trip',
    description:
      "Bundles the roster, per-kid habit progress, weekly streaks, pending-task counts, a Today's Snapshot stat row, savings goals, and a merged Recent Activity feed (tasks, meals, calendar activities, habit stickers and approved reward redemptions, newest 5) instead of fanning out to five separate endpoints.",
    response: dashboardTodayResponseSchema,
    responseDesc:
      '`date` is "today" in the family’s timezone; `counts.tasksTotalToday` is tasks done today plus every still-open task',
  },
};
