import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { habits, members, tenants } from '../db/schema.js';
import { DEFAULT_STICKER_RATE_MINOR } from './reward-config.js';
import { isKidRole, type GetStartedState, type GetStartedSteps } from '@familyhub/shared';

// FHS-634: what "done" means for each step of the dashboard Getting started
// guide.
//
// The guide used to tick a step when you tapped its button, and remembered
// that in the browser. So a family with four children and PINs all round was
// still told "0 of 4 done: add your kids" the moment they opened it somewhere
// new. Every step below is now answered from the family's own data, which is
// the only version of the answer that survives changing device.

type Db = ReturnType<typeof getDb>;

export interface GetStartedKid {
  id: string;
  /** bcrypt hash of the kid's PIN; null (or empty) means no PIN yet. */
  pinHash: string | null;
  /** True when this kid owns at least one habit that is not archived. */
  hasHabit: boolean;
  /** This kid's own rate override, in minor units; null = uses the family's. */
  stickerRateMinor: number | null;
}

export interface GetStartedFacts {
  kids: GetStartedKid[];
  /** When an admin saved the family sticker rate; null = never chosen. */
  stickerRateSetAt: Date | null;
  /** The family's current rate in minor units (NOT NULL DEFAULT 50 in the db). */
  familyStickerRateMinor: number;
}

/**
 * Pure step resolver. No I/O, so the rules can be unit-tested on their own.
 *
 * `pins` deliberately requires EVERY kid to have one: a family where one of
 * three children cannot sign in has not finished that step, and saying
 * otherwise sends them past a job that is still half done.
 */
export function deriveGetStartedSteps(facts: GetStartedFacts): GetStartedSteps {
  const hasKids = facts.kids.length > 0;
  // The rate step has three ways to be true, because the timestamp only exists
  // from FHS-634 onwards. Every family that predates it has a null stamp, and
  // asking a family who has been running for months to "choose what a sticker
  // is worth" is exactly the nagging this ticket exists to stop. A rate that
  // differs from the default, or any per-child override, is proof enough that
  // somebody already decided. A family still sitting on an untouched 0.50 is
  // genuinely indistinguishable from one that never looked, so they are asked.
  const rateChosen =
    facts.stickerRateSetAt !== null ||
    facts.familyStickerRateMinor !== DEFAULT_STICKER_RATE_MINOR ||
    facts.kids.some((k) => k.stickerRateMinor !== null);
  return {
    kids: hasKids,
    pins: hasKids && facts.kids.every((k) => k.pinHash !== null && k.pinHash !== ''),
    rate: rateChosen,
    habits: facts.kids.some((k) => k.hasHabit),
  };
}

/**
 * Read one family's guide state for one member: the four steps plus whether
 * this person has hidden the guide.
 *
 * Every query is filtered by `tenantId`, so a caller can only ever see their
 * own family (RLS on `members` / `habits` / `tenants` is the backstop).
 */
export async function loadGetStartedState(
  db: Db,
  tenantId: string,
  callerMemberId: string,
): Promise<GetStartedState> {
  const memberRows = await db
    .select({
      id: members.id,
      role: members.role,
      isChild: members.isChild,
      pinHash: members.pinHash,
      stickerRateMinor: members.stickerRateMinor,
      getStartedDismissedAt: members.getStartedDismissedAt,
      createdAt: members.createdAt,
    })
    .from(members)
    .where(eq(members.tenantId, tenantId));

  // `is_child` is the auth-flow flag and `role` is the permission tier; a kid
  // is either (see the members table comment), so both count here.
  const kidRows = memberRows
    .filter((m) => m.isChild || isKidRole(m.role))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const kidIds = kidRows.map((k) => k.id);
  // Only habits belonging to a kid count: onboarding seeds five family-level
  // starter habits with no member_id, and those are not the family choosing
  // anything (see db/seed-tenant-defaults.ts).
  const habitRows =
    kidIds.length > 0
      ? await db
          .selectDistinct({ memberId: habits.memberId })
          .from(habits)
          .where(
            and(
              eq(habits.tenantId, tenantId),
              isNull(habits.archivedAt),
              isNotNull(habits.memberId),
              inArray(habits.memberId, kidIds),
            ),
          )
      : [];
  const kidsWithHabits = new Set(habitRows.map((h) => h.memberId));

  const [tenantRow] = await db
    .select({
      stickerRateSetAt: tenants.stickerRateSetAt,
      stickerRateMinor: tenants.stickerRateMinor,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const steps = deriveGetStartedSteps({
    kids: kidRows.map((k) => ({
      id: k.id,
      pinHash: k.pinHash,
      hasHabit: kidsWithHabits.has(k.id),
      stickerRateMinor: k.stickerRateMinor,
    })),
    stickerRateSetAt: tenantRow?.stickerRateSetAt ?? null,
    familyStickerRateMinor: tenantRow?.stickerRateMinor ?? DEFAULT_STICKER_RATE_MINOR,
  });

  const caller = memberRows.find((m) => m.id === callerMemberId);

  return {
    dismissed: (caller?.getStartedDismissedAt ?? null) !== null,
    steps,
    firstKidId: kidRows[0]?.id ?? null,
  };
}
