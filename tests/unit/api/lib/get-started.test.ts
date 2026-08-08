import { describe, it, expect } from 'vitest';
import { deriveGetStartedSteps } from '../../../../apps/api/src/lib/get-started';

// FHS-634: the guide used to tick a step when you tapped its button and keep
// that in the browser. These lock the replacement: a step is done when the
// family really has the thing.

const kid = (
  over: Partial<{
    id: string;
    pinHash: string | null;
    hasHabit: boolean;
    stickerRateMinor: number | null;
  }> = {},
) => ({
  id: 'k1',
  pinHash: null as string | null,
  hasHabit: false,
  stickerRateMinor: null as number | null,
  ...over,
});

/** A family on the untouched defaults: nothing chosen, nothing overridden. */
const facts = (over: Partial<Parameters<typeof deriveGetStartedSteps>[0]> = {}) => ({
  kids: [],
  stickerRateSetAt: null,
  familyStickerRateMinor: 50,
  ...over,
});

describe('deriveGetStartedSteps (FHS-634)', () => {
  it('an empty family has nothing done', () => {
    expect(deriveGetStartedSteps(facts())).toEqual({
      kids: false,
      pins: false,
      rate: false,
      habits: false,
    });
  });

  it('one child is enough for the kids step', () => {
    expect(deriveGetStartedSteps(facts({ kids: [kid()] })).kids).toBe(true);
  });

  it('the PIN step needs EVERY kid to have one', () => {
    const someone = deriveGetStartedSteps(
      facts({ kids: [kid({ id: 'a', pinHash: 'hash' }), kid({ id: 'b', pinHash: null })] }),
    );
    expect(someone.pins).toBe(false);

    const everyone = deriveGetStartedSteps(
      facts({ kids: [kid({ id: 'a', pinHash: 'hash' }), kid({ id: 'b', pinHash: 'hash' })] }),
    );
    expect(everyone.pins).toBe(true);
  });

  it('an empty PIN hash does not count as a PIN', () => {
    expect(deriveGetStartedSteps(facts({ kids: [kid({ pinHash: '' })] })).pins).toBe(false);
  });

  it('a family with no kids at all has not done the PIN step', () => {
    // `[].every(...)` is true, which would have quietly ticked the step for a
    // family that has nobody to give a PIN to.
    expect(deriveGetStartedSteps(facts()).pins).toBe(false);
  });

  it('the rate step is done once it has been saved', () => {
    expect(deriveGetStartedSteps(facts()).rate).toBe(false);
    expect(
      deriveGetStartedSteps(facts({ stickerRateSetAt: new Date('2026-08-08T00:00:00Z') })).rate,
    ).toBe(true);
  });

  it('a rate that is not the default counts as chosen, stamp or no stamp', () => {
    // FHS-634 review: every family that predates this ticket has a null stamp.
    // Without this, a family running happily on 1.00 a sticker would be told to
    // go and choose what a sticker is worth.
    expect(deriveGetStartedSteps(facts({ familyStickerRateMinor: 100 })).rate).toBe(true);
  });

  it('a per-child rate override counts as chosen too', () => {
    expect(deriveGetStartedSteps(facts({ kids: [kid({ stickerRateMinor: 75 })] })).rate).toBe(true);
  });

  it('an untouched default rate is still worth asking about', () => {
    // 0.50 with no stamp and no override is indistinguishable from never
    // having looked, so the family is asked once.
    expect(deriveGetStartedSteps(facts({ kids: [kid()], familyStickerRateMinor: 50 })).rate).toBe(
      false,
    );
  });

  it('one kid with a habit of their own is enough for the habits step', () => {
    expect(
      deriveGetStartedSteps(
        facts({ kids: [kid({ id: 'a', hasHabit: false }), kid({ id: 'b', hasHabit: true })] }),
      ).habits,
    ).toBe(true);
  });

  it('a fully set-up family has all four done', () => {
    expect(
      deriveGetStartedSteps(
        facts({
          kids: [kid({ pinHash: 'hash', hasHabit: true })],
          stickerRateSetAt: new Date('2026-08-08T00:00:00Z'),
        }),
      ),
    ).toEqual({ kids: true, pins: true, rate: true, habits: true });
  });
});
