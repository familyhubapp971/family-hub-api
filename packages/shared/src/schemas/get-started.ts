import { z } from 'zod';

// FHS-634: response contract for the dashboard "Getting started" guide.
//
// The guide used to keep its state in the browser's own storage, so a parent
// who dismissed it saw it again on their next device, and it always claimed
// "0 of 4 done" no matter how set up the family already was. State now lives
// on the server: `dismissed` is stored per member, and the four steps are
// derived from what the family actually has, not from which buttons were
// tapped in this browser.

export const GET_STARTED_STEP_KEYS = ['kids', 'pins', 'rate', 'habits'] as const;

export type GetStartedStepKey = (typeof GET_STARTED_STEP_KEYS)[number];

export const getStartedStepsSchema = z.object({
  /** The family has at least one child or teen. */
  kids: z.boolean(),
  /** Every kid can sign in: each one has a PIN set. */
  pins: z.boolean(),
  /** An admin has chosen what a sticker is worth (see tenants.sticker_rate_set_at). */
  rate: z.boolean(),
  /** At least one kid has a habit of their own. */
  habits: z.boolean(),
});

export type GetStartedSteps = z.infer<typeof getStartedStepsSchema>;

export const getStartedStateSchema = z.object({
  /** True once this member hides the guide; it then stays hidden everywhere. */
  dismissed: z.boolean(),
  steps: getStartedStepsSchema,
  /** Deep-link target for the "Open their world" step; null before any kid exists. */
  firstKidId: z.string().uuid().nullable(),
});

export type GetStartedState = z.infer<typeof getStartedStateSchema>;

export const getStartedDismissResponseSchema = z.object({
  dismissed: z.literal(true),
});

export type GetStartedDismissResponse = z.infer<typeof getStartedDismissResponseSchema>;

/** How many of the four steps are done. */
export function countGetStartedDone(steps: GetStartedSteps): number {
  return GET_STARTED_STEP_KEYS.filter((k) => steps[k]).length;
}
