// FHS-384 — Pure aggregation helpers for the parent Learn Insights endpoint.
//
// No auth / middleware here. The route (routes/learn-insights.ts) handles all
// auth guards, then calls `computeLearnInsights` with already-scoped
// (tenantId, memberId).
//
// ── progressPct rounding convention ──────────────────────────────────────────
// ALL progressPct values use Math.floor (truncate, not round). This ensures
// the bar never "over-promises": a kid who has earned 6/48 Maths certificates
// sees 12% (floor(12.5)), not 13% (round). It also makes expected values in
// tests deterministic: multiply, divide, floor — no half-up surprises.
//
// ── Heuristics ─────────────────────────────────────────────────────────────────
//   Maths      — ≥5 attempts: accuracy < 0.70 → flagged (certsEarned irrelevant).
//                <5 attempts: progressPct < 25 AND avgProveTime > 10 s (proxy).
//   Logic      — ≥5 attempts: accuracy < 0.70 → flagged (same pattern as Maths).
//                <5 attempts: progressPct < 20 (proxy; no flag if 0 certs yet).
//   Science    — totalAnswered >= 5 AND accuracy < 0.60.
//   World Flags — 0 < explored < 10 countries (barely started).
//
// ── weakest subject ────────────────────────────────────────────────────────────
// The subject with the lowest progressPct among those with ANY activity
// (lastActive != null). Ties resolve to the first subject in array order
// (Maths → Logic → Science → World Flags) because Array.reduce picks the
// first equal element.
//
// ── World Flags certificatesEarned / certificatesTotal ────────────────────────
// WF has no per-country cert table. We treat "continents fully explored" as
// the cert signal: a continent is "done" when the kid has explored all
// countries in it (cross-referenced against CONTINENT_COUNTRY_COUNTS).
// certificatesTotal = number of distinct continents (6 per the CONTINENTS list
// in world-flags.ts). progressPct is driven by raw explored-country count /
// WORLD_FLAGS_COUNTRIES_TOTAL, independent of continent completions.

import { and, count, eq, max, sql, sum } from 'drizzle-orm';
import {
  learnProgress,
  mwLogicCertificates,
  mwLogicProgress,
  mwMathsCertificates,
  mwMathsProgress,
  worldFlagsProgress,
} from '../db/schema.js';
import type { Database } from '../db/client.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * 4 operations × 12 tables = 48 possible Maths certificates.
 * Only numeric-difficulty rows ('1'..'12') count toward this total —
 * legacy 'easy'|'medium'|'hard' rows are excluded from the cert-count query.
 */
export const MATHS_CERTS_TOTAL = 48;

/** 5 game types × 3 difficulties = 15 possible Logic certificates. */
export const LOGIC_CERTS_TOTAL = 15;

/**
 * Total distinct country codes in the World Flags dataset (~197 UN-recognized
 * sovereign states tracked by the web app's countries.ts).
 * Used for progressPct only (explored / total).
 */
export const WORLD_FLAGS_COUNTRIES_TOTAL = 197;

/**
 * Number of continents in the World Flags dataset.
 * Matches CONTINENTS array in lib/world-flags.ts (6 entries).
 * Used as certificatesTotal for World Flags — a "certificate" = a fully
 * explored continent.
 */
export const WORLD_FLAGS_CONTINENTS_TOTAL = 6;

// ─── Response types ───────────────────────────────────────────────────────────

export interface SubjectInsight {
  subject: 'Maths' | 'Logic' | 'Science' | 'World Flags';
  /** 0–100 integer, floor-rounded (see rounding convention above). */
  progressPct: number;
  certificatesEarned: number;
  certificatesTotal: number;
  /** ISO 8601 string or null (no activity yet) */
  lastActive: string | null;
  needsHelp: boolean;
  /**
   * FHS-401 — per-subject accuracy as a 0–100 integer (floor-rounded), or null
   * when no attempts have been recorded yet.
   *
   * Maths:        round(totalCorrect / totalAttempts * 100) across all progress rows.
   * Logic:        round(sum(correctCount) / sum(totalAttempts) * 100) across all rows.
   * Science:      round(totalCorrect / totalAnswered * 100) from learn_progress.
   * World Flags:  null — quiz attempt tracking not yet implemented server-side.
   */
  accuracyPct: number | null;
}

export interface WeakestDetail {
  subject: 'Maths' | 'Logic' | 'Science' | 'World Flags';
  /** e.g. "division tables", "sorting (needs most practice)" */
  detail: string;
  /** One-line friendly tip for parents */
  tip: string;
}

export interface LearnInsightsResult {
  memberId: string;
  displayName: string;
  subjects: SubjectInsight[];
  weakest: WeakestDetail | null;
  hasActivity: boolean;
}

// ─── Internal raw aggregates ──────────────────────────────────────────────────

interface MathsRaw {
  /** Count of rows where difficulty is a numeric table number ('1'..'12') */
  certsEarned: number;
  lastActive: Date | null;
  /** Average proveAvgTime across all rows where proveAvgTime > 0, or 0 */
  avgProveTime: number;
  /** FHS-401 — sum of total_correct across all mw_maths_progress rows for this kid. */
  totalCorrect: number;
  /** FHS-401 — sum of total_attempts across all mw_maths_progress rows for this kid. */
  totalAttempts: number;
}

interface LogicRaw {
  certsEarned: number;
  lastActive: Date | null;
  correctByGame: Record<string, number>;
  weakestGame: string | null;
  /** FHS-401 — sum of correct_count across all mw_logic_progress rows for this kid. */
  sumCorrect: number;
  /** FHS-401 — sum of total_attempts across all mw_logic_progress rows for this kid. */
  sumAttempts: number;
}

interface ScienceRaw {
  progress: number;
  totalCorrect: number;
  totalAnswered: number;
  certificateAt: Date | null;
  lastActive: Date | null;
}

interface WorldFlagsRaw {
  explored: number;
  lastActive: Date | null;
}

// ─── Per-subject DB queries ───────────────────────────────────────────────────

async function fetchMaths(db: Database, tenantId: string, memberId: string): Promise<MathsRaw> {
  // Only count numeric-difficulty certificates ('1'..'12') — excludes legacy
  // 'easy'|'medium'|'hard' rows so certsEarned can never exceed MATHS_CERTS_TOTAL.
  const [certsRow] = await db
    .select({ certsEarned: count() })
    .from(mwMathsCertificates)
    .where(
      and(
        eq(mwMathsCertificates.tenantId, tenantId),
        eq(mwMathsCertificates.memberId, memberId),
        sql`${mwMathsCertificates.difficulty} ~ '^[0-9]+$'`,
      ),
    );

  const [progressRow] = await db
    .select({
      lastActive: max(mwMathsProgress.updatedAt),
      avgProveTime: sql<number>`coalesce(avg(nullif(${mwMathsProgress.proveAvgTime}, 0)), 0)`,
      // FHS-401 — sum across all rows for this kid (different rows = different tables).
      totalCorrect: sql<number>`coalesce(sum(${mwMathsProgress.totalCorrect}), 0)`,
      totalAttempts: sql<number>`coalesce(sum(${mwMathsProgress.totalAttempts}), 0)`,
    })
    .from(mwMathsProgress)
    .where(and(eq(mwMathsProgress.tenantId, tenantId), eq(mwMathsProgress.memberId, memberId)));

  return {
    certsEarned: Number(certsRow?.certsEarned ?? 0),
    lastActive: progressRow?.lastActive ?? null,
    avgProveTime: Number(progressRow?.avgProveTime ?? 0),
    totalCorrect: Number(progressRow?.totalCorrect ?? 0),
    totalAttempts: Number(progressRow?.totalAttempts ?? 0),
  };
}

async function fetchLogic(db: Database, tenantId: string, memberId: string): Promise<LogicRaw> {
  const [certsRow] = await db
    .select({ certsEarned: count() })
    .from(mwLogicCertificates)
    .where(
      and(eq(mwLogicCertificates.tenantId, tenantId), eq(mwLogicCertificates.memberId, memberId)),
    );

  // Progress rows grouped by game_type — for weakest game detection and accuracy sums.
  const progressRows = await db
    .select({
      gameType: mwLogicProgress.gameType,
      totalCorrect: sum(mwLogicProgress.correctCount),
      totalAttempts: sum(mwLogicProgress.totalAttempts),
      lastUpdated: max(mwLogicProgress.updatedAt),
    })
    .from(mwLogicProgress)
    .where(and(eq(mwLogicProgress.tenantId, tenantId), eq(mwLogicProgress.memberId, memberId)))
    .groupBy(mwLogicProgress.gameType);

  // Certs per game type.
  const certsPerGame = await db
    .select({ gameType: mwLogicCertificates.gameType, certCount: count() })
    .from(mwLogicCertificates)
    .where(
      and(eq(mwLogicCertificates.tenantId, tenantId), eq(mwLogicCertificates.memberId, memberId)),
    )
    .groupBy(mwLogicCertificates.gameType);

  const certsByGame: Record<string, number> = {};
  for (const r of certsPerGame) certsByGame[r.gameType] = Number(r.certCount);

  const correctByGame: Record<string, number> = {};
  let lastActive: Date | null = null;
  // FHS-401 — aggregate across all game_type rows for subject-level accuracy.
  let sumCorrect = 0;
  let sumAttempts = 0;
  for (const r of progressRows) {
    correctByGame[r.gameType] = Number(r.totalCorrect ?? 0);
    sumCorrect += Number(r.totalCorrect ?? 0);
    sumAttempts += Number(r.totalAttempts ?? 0);
    if (r.lastUpdated && (!lastActive || r.lastUpdated > lastActive)) {
      lastActive = r.lastUpdated;
    }
  }

  // Weakest game = game with fewest certs; tie-break by fewest total correct answers.
  let weakestGame: string | null = null;
  if (progressRows.length > 0) {
    const allGames = progressRows.map((r) => r.gameType);
    allGames.sort((a, b) => {
      const certDiff = (certsByGame[a] ?? 0) - (certsByGame[b] ?? 0);
      if (certDiff !== 0) return certDiff;
      return (correctByGame[a] ?? 0) - (correctByGame[b] ?? 0);
    });
    weakestGame = allGames[0] ?? null;
  }

  return {
    certsEarned: Number(certsRow?.certsEarned ?? 0),
    lastActive,
    correctByGame,
    weakestGame,
    sumCorrect,
    sumAttempts,
  };
}

async function fetchScience(db: Database, tenantId: string, memberId: string): Promise<ScienceRaw> {
  const [row] = await db
    .select({
      progress: learnProgress.progress,
      totalCorrect: learnProgress.totalCorrect,
      totalAnswered: learnProgress.totalAnswered,
      certificateAt: learnProgress.certificateAt,
      lastActive: learnProgress.updatedAt,
    })
    .from(learnProgress)
    .where(
      and(
        eq(learnProgress.tenantId, tenantId),
        eq(learnProgress.memberId, memberId),
        eq(learnProgress.subject, 'Science'),
      ),
    )
    .limit(1);

  return {
    progress: row?.progress ?? 0,
    totalCorrect: row?.totalCorrect ?? 0,
    totalAnswered: row?.totalAnswered ?? 0,
    certificateAt: row?.certificateAt ?? null,
    lastActive: row?.lastActive ?? null,
  };
}

async function fetchWorldFlags(
  db: Database,
  tenantId: string,
  memberId: string,
): Promise<WorldFlagsRaw> {
  const [row] = await db
    .select({
      explored: count(),
      lastActive: max(worldFlagsProgress.exploredAt),
    })
    .from(worldFlagsProgress)
    .where(
      and(eq(worldFlagsProgress.tenantId, tenantId), eq(worldFlagsProgress.memberId, memberId)),
    );

  return {
    explored: Number(row?.explored ?? 0),
    lastActive: row?.lastActive ?? null,
  };
}

// ─── Heuristic helpers ────────────────────────────────────────────────────────

function mathsNeedsHelp(
  certsEarned: number,
  avgProveTime: number,
  totalCorrect: number,
  totalAttempts: number,
): boolean {
  // FHS-401: when we have enough real signal (≥5 attempts), use accuracy alone.
  // Threshold 0.70: a kid at ~61% is genuinely struggling and should be flagged
  // even if they have 0 certs (the old certsEarned>0 guard was a proxy from
  // before accuracy data existed — a struggling new kid is exactly who needs help).
  if (totalAttempts >= 5) {
    return totalCorrect / totalAttempts < 0.7;
  }
  // Fallback heuristic (brand-new kid with <5 attempts — not enough signal yet):
  // don't flag until there's real data, unless certs+speed signal struggling.
  if (certsEarned === 0) return false;
  const progressPct = Math.floor((certsEarned / MATHS_CERTS_TOTAL) * 100);
  return progressPct < 25 && avgProveTime > 10;
}

function logicNeedsHelp(certsEarned: number, sumCorrect: number, sumAttempts: number): boolean {
  // FHS-401: same pattern as mathsNeedsHelp — real accuracy takes priority when
  // ≥5 attempts recorded. Threshold 0.70 (matches Maths). certsEarned=0 is NOT
  // a guard here: a struggling kid with no certs yet is exactly who needs help.
  if (sumAttempts >= 5) {
    return sumCorrect / sumAttempts < 0.7;
  }
  // Fallback (brand-new kid, <5 attempts): no flag until there's real signal.
  if (certsEarned === 0) return false;
  return Math.floor((certsEarned / LOGIC_CERTS_TOTAL) * 100) < 20;
}

function scienceNeedsHelp(totalAnswered: number, totalCorrect: number): boolean {
  if (totalAnswered < 5) return false;
  return totalCorrect / totalAnswered < 0.6;
}

function worldFlagsNeedsHelp(explored: number): boolean {
  // Started exploring but < 10 countries — nudge parent.
  return explored > 0 && explored < 10;
}

// ─── Tip map ─────────────────────────────────────────────────────────────────

const TIPS: Record<string, string> = {
  Maths: 'Try the Prove stage daily to build speed — even one table a day helps.',
  Logic: 'Play logic games together; talk through the "why" behind each answer.',
  Science: 'Re-read the Learn cards before answering questions to boost accuracy.',
  'World Flags': 'Explore a new continent together and quiz each other on the flags.',
};

function gameTypeLabel(gameType: string): string {
  const labels: Record<string, string> = {
    truefalse: 'true or false',
    patterns: 'patterns',
    oddoneout: 'odd one out',
    ifthen: 'if-then',
    sorting: 'sorting',
  };
  return labels[gameType] ?? gameType;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Aggregates Learn data from four subjects for one child.
 *
 * Scoped exclusively to (tenantId, memberId) — callers must have already
 * verified the target member belongs to the caller's tenant AND is a child.
 */
export async function computeLearnInsights(
  db: Database,
  tenantId: string,
  memberId: string,
): Promise<Omit<LearnInsightsResult, 'displayName'>> {
  // Run all four subject queries concurrently.
  const [maths, logic, science, flags] = await Promise.all([
    fetchMaths(db, tenantId, memberId),
    fetchLogic(db, tenantId, memberId),
    fetchScience(db, tenantId, memberId),
    fetchWorldFlags(db, tenantId, memberId),
  ]);

  // ── Maths subject ────────────────────────────────────────────────────────
  // progressPct uses Math.floor (see rounding convention at top of file).
  const mathsPct = Math.min(100, Math.floor((maths.certsEarned / MATHS_CERTS_TOTAL) * 100));
  // FHS-401: accuracy = total_correct / total_attempts, null when no attempts yet.
  // Clamped to 100 — a client sending more correct than attempts is a bug, not
  // a reason to 500 (the Zod response schema declares max(100)).
  const mathsAccuracy =
    maths.totalAttempts > 0
      ? Math.min(100, Math.round((maths.totalCorrect / maths.totalAttempts) * 100))
      : null;
  const mathsSubject: SubjectInsight = {
    subject: 'Maths',
    progressPct: mathsPct,
    certificatesEarned: maths.certsEarned,
    certificatesTotal: MATHS_CERTS_TOTAL,
    lastActive: maths.lastActive?.toISOString() ?? null,
    needsHelp: mathsNeedsHelp(
      maths.certsEarned,
      maths.avgProveTime,
      maths.totalCorrect,
      maths.totalAttempts,
    ),
    accuracyPct: mathsAccuracy,
  };

  // ── Logic subject ────────────────────────────────────────────────────────
  const logicPct = Math.min(100, Math.floor((logic.certsEarned / LOGIC_CERTS_TOTAL) * 100));
  // FHS-401: accuracy = sum(correctCount) / sum(totalAttempts) across all rows.
  // Clamped to 100 defensively (see Maths comment above).
  const logicAccuracy =
    logic.sumAttempts > 0
      ? Math.min(100, Math.round((logic.sumCorrect / logic.sumAttempts) * 100))
      : null;
  const logicSubject: SubjectInsight = {
    subject: 'Logic',
    progressPct: logicPct,
    certificatesEarned: logic.certsEarned,
    certificatesTotal: LOGIC_CERTS_TOTAL,
    lastActive: logic.lastActive?.toISOString() ?? null,
    needsHelp: logicNeedsHelp(logic.certsEarned, logic.sumCorrect, logic.sumAttempts),
    accuracyPct: logicAccuracy,
  };

  // ── Science subject ──────────────────────────────────────────────────────
  // progressPct = learn_progress.progress column (0–100 integer set by the
  // Learn flow). Clamped to [0, 100] defensively in case of column drift.
  // certificatesEarned = 1 if certificate_at is set, else 0.
  const scienceCerts = science.certificateAt ? 1 : 0;
  // FHS-401: Science already has total_correct/total_answered in learn_progress.
  // total_answered = every individual answer submission (including retries on
  // the same question card), so accuracyPct reflects overall answer quality,
  // not distinct questions seen. Clamped to 100 defensively.
  const scienceAccuracy =
    science.totalAnswered > 0
      ? Math.min(100, Math.round((science.totalCorrect / science.totalAnswered) * 100))
      : null;
  const scienceSubject: SubjectInsight = {
    subject: 'Science',
    progressPct: Math.min(100, Math.max(0, science.progress)),
    certificatesEarned: scienceCerts,
    certificatesTotal: 1,
    lastActive: science.lastActive?.toISOString() ?? null,
    needsHelp: scienceNeedsHelp(science.totalAnswered, science.totalCorrect),
    accuracyPct: scienceAccuracy,
  };

  // ── World Flags subject ──────────────────────────────────────────────────
  // progressPct  = explored countries / 197 (floor-rounded).
  // certificatesEarned = number of fully-explored continents (one per
  //   continent where every country in it has been explored). This is a proxy
  //   since WF has no dedicated cert table; it's coherent: completing a
  //   continent is the natural "achievement". certificatesTotal = 6 continents.
  // hasActivity trigger: lastActive from world_flags_progress (any explore).
  // FHS-401: World Flags quiz correct/attempts are NOT tracked server-side —
  //   world_flags_progress only records which countries were explored, not quiz
  //   answers. accuracyPct = null until a quiz-attempts table is added.
  const flagsPct = Math.min(100, Math.floor((flags.explored / WORLD_FLAGS_COUNTRIES_TOTAL) * 100));
  // Continent completion is not queryable here without the full country list.
  // We use the world_flags_learn_progress table (one row per completed chunk)
  // as a cheaper proxy: count DISTINCT continents where the kid has at least
  // one completed chunk. A full continent completion is tracked via the learn
  // path separately. For now, certificatesEarned = 0 (accurate: no WF cert
  // table exists yet). TODO(FHS-future): switch to continent-completion count
  // once the WF cert table is added.
  const flagsSubject: SubjectInsight = {
    subject: 'World Flags',
    progressPct: flagsPct,
    certificatesEarned: 0,
    certificatesTotal: WORLD_FLAGS_CONTINENTS_TOTAL,
    lastActive: flags.lastActive?.toISOString() ?? null,
    needsHelp: worldFlagsNeedsHelp(flags.explored),
    accuracyPct: null,
  };

  const subjects: SubjectInsight[] = [mathsSubject, logicSubject, scienceSubject, flagsSubject];

  // ── hasActivity ──────────────────────────────────────────────────────────
  // A subject has activity if it has a lastActive date OR certificatesEarned > 0.
  // For World Flags, explored > 0 is signaled by lastActive being non-null.
  const hasActivity = subjects.some((s) => s.lastActive !== null || s.certificatesEarned > 0);

  // ── weakest ──────────────────────────────────────────────────────────────
  // Only consider subjects with some activity.
  // Ties resolve to the first subject in array order (Maths→Logic→Science→World
  // Flags) because Array.reduce picks the first equal element.
  const active = subjects.filter((s) => s.lastActive !== null || s.certificatesEarned > 0);
  let weakest: WeakestDetail | null = null;

  if (active.length > 0) {
    const lowest = active.reduce((a, b) => (a.progressPct <= b.progressPct ? a : b));

    let detail: string;
    if (lowest.subject === 'Logic' && logic.weakestGame) {
      detail = `${gameTypeLabel(logic.weakestGame)} (needs most practice)`;
    } else if (lowest.subject === 'Maths') {
      detail = 'low certificate count — keep practising tables';
    } else if (lowest.subject === 'Science') {
      const acc =
        science.totalAnswered > 0
          ? Math.floor((science.totalCorrect / science.totalAnswered) * 100)
          : 0;
      detail = `${acc}% accuracy in Science questions`;
    } else {
      // World Flags
      detail = `explored ${flags.explored} of ${WORLD_FLAGS_COUNTRIES_TOTAL} countries`;
    }

    weakest = {
      subject: lowest.subject,
      detail,
      tip: TIPS[lowest.subject] ?? 'Keep practising together!',
    };
  }

  return { memberId, subjects, weakest, hasActivity };
}
