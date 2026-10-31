// FHS-608: where a finished week's stickers ended up.
//
// A closed week records an audit row per action (mw_week_actions). Both the
// parent board and the kid recap were bucketing those rows into "saved" and
// "invested" with their own copy of the same filters, so this is the one place
// that decides what each action type means.

/** The fields this needs off a week action. The full row carries more. */
export interface WeekActionLike {
  actionType: string;
  stickersUsed: number | null;
}

export interface WeekOutcome {
  /** Banked in savings, including the auto-save a close-week can apply. */
  saved: number;
  /** Put into a habit, less anything pulled back out of one. */
  invested: number;
  /** Claimed against a reward. */
  spent: number;
  /** Turned into money. */
  cashedOut: number;
  /** saved + invested + spent + cashedOut. */
  total: number;
}

function sumOf(actions: readonly WeekActionLike[], types: readonly string[]): number {
  return actions
    .filter((a) => types.includes(a.actionType))
    .reduce((sum, a) => sum + (a.stickersUsed ?? 0), 0);
}

/**
 * Split a finished week's actions into what happened to the stickers.
 *
 * `invest_continue` is deliberately NOT counted. When a week closes, an
 * investment that keeps running writes one of those carrying its ENTIRE
 * current value, not the stickers newly committed. Counting it reported the
 * same investment again every week it rolled forward: a founder screenshot
 * showed a week that earned 21 stickers claiming 101 invested (FHS-617).
 *
 * `withdraw` takes stickers back out of an investment, so it nets off the
 * invested figure rather than counting as its own outcome. The result is
 * clamped at zero: a week that withdrew more than it invested (possible when
 * the investment was opened in an earlier week) reads as nothing invested,
 * never as a negative.
 */
export function summariseWeekActions(actions: readonly WeekActionLike[]): WeekOutcome {
  const saved = sumOf(actions, ['save', 'auto_save']);
  const invested = Math.max(0, sumOf(actions, ['invest']) - sumOf(actions, ['withdraw']));
  const spent = sumOf(actions, ['claim']);
  const cashedOut = sumOf(actions, ['cashout']);
  return { saved, invested, spent, cashedOut, total: saved + invested + spent + cashedOut };
}
