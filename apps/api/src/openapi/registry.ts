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
  kidMeResponseSchema,
  kidProfileResponseSchema,
  kidTasksResponseSchema,
  kidTodayResponseSchema,
} from '../routes/kid.js';
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
