// FHS-373 — pure DB helpers shared between /api/world-flags (parent) and
// /api/kid/world-flags (kid). No auth / middleware concerns here — callers
// are responsible for scoping tenantId + memberId to the right principal.

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { worldFlagsProgress, worldFlagsLearnProgress } from '../db/schema.js';
import type { Database } from '../db/client.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const CONTINENTS = [
  'Africa',
  'Asia',
  'Europe',
  'North America',
  'South America',
  'Oceania',
] as const;

export type Continent = (typeof CONTINENTS)[number];

// ─── Kid-route body schemas (no memberId — identity comes from the token) ─────

export const worldFlagsExploreBodySchema = z.object({
  // ISO 3166-1 alpha-2 or alpha-3 (2–3 chars).
  countryCode: z.string().min(2).max(3),
});

export const worldFlagsLearnCompleteBodySchema = z.object({
  continent: z.enum(CONTINENTS),
  // Zero-based index of the completed set (≤ 60 to reject junk).
  chunkIndex: z.number().int().min(0).max(60),
});

// ─── DB helpers ───────────────────────────────────────────────────────────────

/** All country codes this member has explored, in DB order. */
export async function listExplored(
  db: Database,
  tenantId: string,
  memberId: string,
): Promise<string[]> {
  const rows = await db
    .select({ countryCode: worldFlagsProgress.countryCode })
    .from(worldFlagsProgress)
    .where(
      and(eq(worldFlagsProgress.tenantId, tenantId), eq(worldFlagsProgress.memberId, memberId)),
    );
  return rows.map((r) => r.countryCode);
}

/** Idempotent: marks a country code explored (onConflictDoNothing). */
export async function addExplored(
  db: Database,
  tenantId: string,
  memberId: string,
  countryCode: string,
): Promise<void> {
  await db
    .insert(worldFlagsProgress)
    .values({ tenantId, memberId, countryCode })
    .onConflictDoNothing();
}

/**
 * Completed set indices per continent for the structured learn path.
 * Each continent's array is sorted ascending.
 */
export async function listLearnProgress(
  db: Database,
  tenantId: string,
  memberId: string,
): Promise<Record<string, number[]>> {
  const rows = await db
    .select({
      continent: worldFlagsLearnProgress.continent,
      chunkIndex: worldFlagsLearnProgress.chunkIndex,
    })
    .from(worldFlagsLearnProgress)
    .where(
      and(
        eq(worldFlagsLearnProgress.tenantId, tenantId),
        eq(worldFlagsLearnProgress.memberId, memberId),
      ),
    );
  const progress: Record<string, number[]> = {};
  for (const r of rows) {
    (progress[r.continent] ??= []).push(r.chunkIndex);
  }
  for (const key of Object.keys(progress)) progress[key]!.sort((a, b) => a - b);
  return progress;
}

/** Idempotent: marks a set as mastered (onConflictDoNothing). */
export async function addLearnComplete(
  db: Database,
  tenantId: string,
  memberId: string,
  continent: Continent,
  chunkIndex: number,
): Promise<void> {
  await db
    .insert(worldFlagsLearnProgress)
    .values({ tenantId, memberId, continent, chunkIndex })
    .onConflictDoNothing();
}
