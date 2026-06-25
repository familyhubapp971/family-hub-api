// FHS-384 — Unit tests for lib/learn-insights.ts
//
// Tests cover:
//   - computeLearnInsights aggregation + needsHelp heuristics per subject
//   - weakest detection (lowest progressPct among subjects with activity)
//   - weakest tie-break: ties resolve to first in array order (Maths→Logic→Science→WF)
//   - empty-state: child with no activity → hasActivity false, all zeroed, weakest null
//
// Mock call ordering (Promise.all concurrent, but JS single-threaded):
//   fetchMaths    → call 1: maths certs count
//   fetchLogic    → call 2: logic certs count
//   fetchScience  → call 3: science learn_progress row
//   fetchFlags    → call 4: world_flags_progress count
//   fetchMaths    → call 5: maths progress aggregate (lastActive, avgProveTime)
//   fetchLogic    → call 6: logic progress rows (grouped by game_type)
//   fetchLogic    → call 7: logic certs per game_type

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeLearnInsights,
  MATHS_CERTS_TOTAL,
  LOGIC_CERTS_TOTAL,
  WORLD_FLAGS_CONTINENTS_TOTAL,
} from '../../../../apps/api/src/lib/learn-insights.js';

// ─── Mock the drizzle DB client ───────────────────────────────────────────────

type Row = Record<string, unknown>;

let dbReturns: Row[][] = [];
let callIndex = 0;

const dbMock = {
  select: vi.fn(),
};

function chainWith(rows: Row[]) {
  // whereResult is itself a Promise (resolves to rows) AND has .limit() / .groupBy()
  // for chains that continue past .where().
  const whereResult = Object.assign(Promise.resolve(rows), {
    limit: () => Promise.resolve(rows),
    groupBy: () => Promise.resolve(rows),
  });
  const fromResult = {
    where: () => whereResult,
    groupBy: () => Promise.resolve(rows),
    limit: () => Promise.resolve(rows),
  };
  return {
    from: () => fromResult,
  };
}

vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
}));

/**
 * Set up the mock DB to return the given row sets in order per call.
 * Call order (fixed by Promise.all async behaviour in single-threaded JS):
 *   1 = maths certs count
 *   2 = logic certs count
 *   3 = science learn_progress row
 *   4 = world_flags_progress count
 *   5 = maths progress agg (lastActive, avgProveTime)
 *   6 = logic progress rows (grouped by game_type)
 *   7 = logic certs per game_type
 */
function setupDbReturns(
  mathsCerts: Row[],
  logicCerts: Row[],
  science: Row[],
  flags: Row[],
  mathsProgress: Row[],
  logicProgressRows: Row[],
  logicCertsPerGame: Row[],
) {
  dbReturns = [
    mathsCerts,
    logicCerts,
    science,
    flags,
    mathsProgress,
    logicProgressRows,
    logicCertsPerGame,
  ];
  callIndex = 0;
  dbMock.select.mockImplementation(() => {
    const rows = dbReturns[callIndex++] ?? [];
    return chainWith(rows);
  });
}

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// ─── Empty state ───────────────────────────────────────────────────────────────

describe('computeLearnInsights — empty state (no activity)', () => {
  beforeEach(() => {
    setupDbReturns([], [], [], [], [], [], []);
  });

  it('returns hasActivity false', async () => {
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.hasActivity).toBe(false);
  });

  it('returns weakest null', async () => {
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.weakest).toBeNull();
  });

  it('returns all subjects at 0 progressPct, 0 certs, null lastActive, needsHelp false', async () => {
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    for (const s of res.subjects) {
      expect(s.progressPct).toBe(0);
      expect(s.certificatesEarned).toBe(0);
      expect(s.lastActive).toBeNull();
      expect(s.needsHelp).toBe(false);
    }
  });

  it('subjects array has 4 entries in order Maths/Logic/Science/World Flags', async () => {
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.map((s) => s.subject)).toEqual([
      'Maths',
      'Logic',
      'Science',
      'World Flags',
    ]);
  });
});

// ─── Maths needsHelp ──────────────────────────────────────────────────────────

describe('computeLearnInsights — Maths needsHelp heuristic', () => {
  it('needsHelp false when no certs (not started)', async () => {
    setupDbReturns(
      [{ certsEarned: '0' }], // maths certs
      [{ certsEarned: '0' }], // logic certs
      [], // science
      [], // flags
      [{ lastActive: new Date('2026-01-01'), avgProveTime: 15 }], // maths progress agg
      [], // logic progress rows
      [], // logic certs per game
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Maths')!.needsHelp).toBe(false);
  });

  it('needsHelp true when progress < 25% AND avgProveTime > 10s', async () => {
    // 2 certs / 48 = ~4% progress (floor(4.16)=4), avg time 12s
    setupDbReturns(
      [{ certsEarned: '2' }], // maths certs
      [{ certsEarned: '0' }], // logic certs
      [], // science
      [], // flags
      [{ lastActive: new Date('2026-01-01'), avgProveTime: 12 }], // maths progress agg
      [], // logic progress rows
      [], // logic certs per game
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Maths')!.needsHelp).toBe(true);
  });

  it('needsHelp false when progress < 25% but avgProveTime <= 10s', async () => {
    setupDbReturns(
      [{ certsEarned: '3' }],
      [{ certsEarned: '0' }],
      [],
      [],
      [{ lastActive: new Date('2026-01-01'), avgProveTime: 8 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Maths')!.needsHelp).toBe(false);
  });

  it('needsHelp false when progress >= 25%', async () => {
    // 12 certs / 48 = 25% (floor(25)=25)
    setupDbReturns(
      [{ certsEarned: '12' }],
      [{ certsEarned: '0' }],
      [],
      [],
      [{ lastActive: new Date('2026-01-01'), avgProveTime: 15 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Maths')!.needsHelp).toBe(false);
  });

  it('progressPct caps at 100', async () => {
    setupDbReturns(
      [{ certsEarned: String(MATHS_CERTS_TOTAL) }],
      [{ certsEarned: '0' }],
      [],
      [],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Maths')!.progressPct).toBe(100);
  });

  it('progressPct uses Math.floor — 6 certs / 48 = floor(12.5) = 12 not 13', async () => {
    // Rounding convention: floor, not round. 6/48 = 0.125 → 12.5% → floor = 12.
    setupDbReturns(
      [{ certsEarned: '6' }],
      [{ certsEarned: '0' }],
      [],
      [],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Maths')!.progressPct).toBe(12);
  });
});

// ─── Logic needsHelp ──────────────────────────────────────────────────────────

describe('computeLearnInsights — Logic needsHelp heuristic', () => {
  it('needsHelp true when progressPct < 20 with activity', async () => {
    // 2 / 15 = floor(13.3) = 13% < 20
    setupDbReturns(
      [{ certsEarned: '0' }], // maths certs
      [{ certsEarned: '2' }], // logic certs
      [], // science
      [], // flags
      [{ lastActive: null, avgProveTime: 0 }], // maths agg
      [{ gameType: 'sorting', totalCorrect: '3', lastUpdated: new Date('2026-01-01') }],
      [{ gameType: 'sorting', certCount: '2' }],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Logic')!.needsHelp).toBe(true);
  });

  it('needsHelp false when progressPct >= 20', async () => {
    // 3 / 15 = floor(20) = 20%
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '3' }],
      [],
      [],
      [{ lastActive: null, avgProveTime: 0 }],
      [{ gameType: 'patterns', totalCorrect: '30', lastUpdated: new Date('2026-01-01') }],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Logic')!.needsHelp).toBe(false);
  });

  it('certificatesTotal is LOGIC_CERTS_TOTAL (15)', async () => {
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '0' }],
      [],
      [],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Logic')!.certificatesTotal).toBe(
      LOGIC_CERTS_TOTAL,
    );
  });
});

// ─── Science needsHelp ────────────────────────────────────────────────────────

describe('computeLearnInsights — Science needsHelp heuristic', () => {
  it('needsHelp false when totalAnswered < 5', async () => {
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '0' }],
      [
        {
          progress: 20,
          totalCorrect: 1,
          totalAnswered: 4,
          certificateAt: null,
          lastActive: new Date('2026-01-01'),
        },
      ],
      [],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Science')!.needsHelp).toBe(false);
  });

  it('needsHelp true when accuracy < 60% with 5+ answers', async () => {
    // 2 / 10 = 20%
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '0' }],
      [
        {
          progress: 50,
          totalCorrect: 2,
          totalAnswered: 10,
          certificateAt: null,
          lastActive: new Date('2026-01-01'),
        },
      ],
      [],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Science')!.needsHelp).toBe(true);
  });

  it('needsHelp false when accuracy >= 60%', async () => {
    // 6 / 10 = 60%
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '0' }],
      [
        {
          progress: 60,
          totalCorrect: 6,
          totalAnswered: 10,
          certificateAt: null,
          lastActive: new Date('2026-01-01'),
        },
      ],
      [],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Science')!.needsHelp).toBe(false);
  });

  it('certificatesEarned = 1 when certificateAt is set', async () => {
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '0' }],
      [
        {
          progress: 100,
          totalCorrect: 10,
          totalAnswered: 10,
          certificateAt: new Date('2026-01-15'),
          lastActive: new Date('2026-01-15'),
        },
      ],
      [],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    const sci = res.subjects.find((s) => s.subject === 'Science')!;
    expect(sci.certificatesEarned).toBe(1);
    expect(sci.certificatesTotal).toBe(1);
  });

  it('progressPct is clamped to [0, 100] — defends against corrupt column values', async () => {
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '0' }],
      [
        {
          progress: 150, // corrupt value above 100
          totalCorrect: 10,
          totalAnswered: 10,
          certificateAt: null,
          lastActive: new Date('2026-01-15'),
        },
      ],
      [],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'Science')!.progressPct).toBe(100);
  });
});

// ─── World Flags ──────────────────────────────────────────────────────────────

describe('computeLearnInsights — World Flags', () => {
  it('needsHelp true when explored > 0 and < 10', async () => {
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '0' }],
      [],
      [{ explored: '5', lastActive: new Date('2026-01-01') }],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'World Flags')!.needsHelp).toBe(true);
  });

  it('needsHelp false when explored = 0 (not started)', async () => {
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '0' }],
      [],
      [{ explored: '0', lastActive: null }],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'World Flags')!.needsHelp).toBe(false);
  });

  it('needsHelp false when explored >= 10', async () => {
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '0' }],
      [],
      [{ explored: '10', lastActive: new Date('2026-01-01') }],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'World Flags')!.needsHelp).toBe(false);
  });

  it('certificatesEarned is 0 (no WF cert table yet)', async () => {
    // World Flags does not yet have a dedicated cert table. certificatesEarned
    // is always 0; certificatesTotal is WORLD_FLAGS_CONTINENTS_TOTAL (6).
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '0' }],
      [],
      [{ explored: '50', lastActive: new Date('2026-01-01') }],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    const wf = res.subjects.find((s) => s.subject === 'World Flags')!;
    expect(wf.certificatesEarned).toBe(0);
    expect(wf.certificatesTotal).toBe(WORLD_FLAGS_CONTINENTS_TOTAL);
  });

  it('progressPct is driven by explored / 197 (not by certificatesEarned)', async () => {
    // 100 explored / 197 = floor(50.76) = 50
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '0' }],
      [],
      [{ explored: '100', lastActive: new Date('2026-01-01') }],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.subjects.find((s) => s.subject === 'World Flags')!.progressPct).toBe(50);
  });
});

// ─── weakest subject ──────────────────────────────────────────────────────────

describe('computeLearnInsights — weakest subject', () => {
  it('weakest is the subject with the lowest progressPct that has activity', async () => {
    // Maths has 6 certs (floor(6/48*100)=12%), Logic has 1 cert (floor(6%)=6%).
    // Logic should be weakest.
    setupDbReturns(
      [{ certsEarned: '6' }], // maths certs → 12%
      [{ certsEarned: '1' }], // logic certs → 6%
      [], // science
      [], // flags
      [{ lastActive: new Date('2026-02-01'), avgProveTime: 3 }],
      [{ gameType: 'truefalse', totalCorrect: '5', lastUpdated: new Date('2026-01-10') }],
      [{ gameType: 'truefalse', certCount: '1' }],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.weakest?.subject).toBe('Logic');
  });

  it('weakest detail names the weakest logic game', async () => {
    setupDbReturns(
      [{ certsEarned: '6' }],
      [{ certsEarned: '1' }],
      [],
      [],
      [{ lastActive: new Date('2026-02-01'), avgProveTime: 3 }],
      [{ gameType: 'sorting', totalCorrect: '2', lastUpdated: new Date('2026-01-10') }],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.weakest?.subject).toBe('Logic');
    expect(res.weakest?.detail).toContain('sorting');
  });

  it('weakest tip is a non-empty string', async () => {
    setupDbReturns(
      [{ certsEarned: '6' }],
      [{ certsEarned: '1' }],
      [],
      [],
      [{ lastActive: new Date('2026-02-01'), avgProveTime: 3 }],
      [{ gameType: 'ifthen', totalCorrect: '4', lastUpdated: new Date('2026-01-10') }],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(typeof res.weakest?.tip).toBe('string');
    expect((res.weakest?.tip ?? '').length).toBeGreaterThan(0);
  });

  it('weakest is null when no subjects have any activity', async () => {
    setupDbReturns([], [], [], [], [], [], []);
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.weakest).toBeNull();
  });

  it('tie-break: Maths wins over Logic when both have equal progressPct (first in array order)', async () => {
    // Both Maths and Logic at 0 progressPct with activity (1 cert each →
    // floor(2%)=2% for Maths, floor(6%)=6% for Logic... that's not a tie).
    // Make them equal: 0 certs each but both have a lastActive date.
    // 0/48 = 0% Maths, 0/15 = 0% Logic → both 0%, both active via lastActive.
    // Array.reduce with (a, b) => a.pct <= b.pct picks the first equal element.
    // Expected winner: Maths (first in array).
    setupDbReturns(
      [{ certsEarned: '0' }], // maths certs → 0%
      [{ certsEarned: '0' }], // logic certs → 0%
      [], // science (no activity)
      [], // flags (no activity)
      [{ lastActive: new Date('2026-01-01'), avgProveTime: 0 }], // maths lastActive → active
      [{ gameType: 'sorting', totalCorrect: '1', lastUpdated: new Date('2026-01-01') }], // logic active
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    // Both Maths and Logic have lastActive and 0% progress. Maths is first in
    // the subjects array, so it wins the tie-break.
    expect(res.weakest?.subject).toBe('Maths');
  });
});

// ─── hasActivity ──────────────────────────────────────────────────────────────

describe('computeLearnInsights — hasActivity', () => {
  it('true when maths certs earned > 0', async () => {
    setupDbReturns(
      [{ certsEarned: '1' }],
      [{ certsEarned: '0' }],
      [],
      [],
      [{ lastActive: new Date('2026-01-01'), avgProveTime: 2 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.hasActivity).toBe(true);
  });

  it('true when science has a lastActive date', async () => {
    setupDbReturns(
      [{ certsEarned: '0' }],
      [{ certsEarned: '0' }],
      [
        {
          progress: 10,
          totalCorrect: 1,
          totalAnswered: 2,
          certificateAt: null,
          lastActive: new Date('2026-03-01'),
        },
      ],
      [],
      [{ lastActive: null, avgProveTime: 0 }],
      [],
      [],
    );
    const res = await computeLearnInsights(dbMock as never, TENANT_ID, MEMBER_ID);
    expect(res.hasActivity).toBe(true);
  });
});
