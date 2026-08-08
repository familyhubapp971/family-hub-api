import { describe, it, expect } from 'vitest';
import { GET_STARTED_STEP_KEYS, countGetStartedDone } from '@familyhub/shared';

// FHS-634: the "N of 4 done" counter the dashboard header renders.

describe('countGetStartedDone', () => {
  it('counts nothing for a family that has not started', () => {
    expect(countGetStartedDone({ kids: false, pins: false, rate: false, habits: false })).toBe(0);
  });

  it('counts only the steps that are done', () => {
    expect(countGetStartedDone({ kids: true, pins: true, rate: false, habits: false })).toBe(2);
  });

  it('counts every step for a family that is set up', () => {
    expect(countGetStartedDone({ kids: true, pins: true, rate: true, habits: true })).toBe(
      GET_STARTED_STEP_KEYS.length,
    );
  });
});
