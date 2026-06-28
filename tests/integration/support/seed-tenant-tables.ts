/**
 * Shared integration-test seeding: one minimal fixture row per tenant-scoped
 * table, in FK-dependency order. Extracted from tenant-isolation.steps.ts
 * (FHS-6) so the RLS sweep (FHS-350) can reuse it instead of duplicating ~360
 * lines. Seed with the OWNER (superuser) connection — it bypasses RLS, so it
 * can populate both tenants before the limited role reads them back.
 */

import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  TENANT_SCOPED_TABLES,
  activityLogs,
  appSettings,
  assignments,
  betaFeedback,
  events,
  habits,
  habitLogs,
  habitStickers,
  investments,
  journalEntries,
  learnProgress,
  mealTemplates,
  members,
  mwInvestments,
  mwLogicCertificates,
  mwLogicProgress,
  mwMathsCertificates,
  mwMathsProgress,
  mwSavings,
  mwSavingsTransactions,
  mwWeekActions,
  mwWeeks,
  notices,
  pendingInvitations,
  readingLog,
  redemptionRequests,
  rewardRedemptions,
  rewards,
  savings,
  savingsTransactions,
  tasks,
  weekActions,
  weeks,
  worldFlagsLearnProgress,
  worldFlagsProgress,
} from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

interface SeedCtx {
  memberId?: string;
  weekId?: string;
  habitId?: string;
  rewardId?: string;
  savingsId?: string;
  mwWeekId?: string;
}

/**
 * Seed one minimal row for `table` under `tenantId`. Parent rows must already
 * be in `ctx` (e.g. week_actions needs member + week + habit) — call via
 * {@link seedAllTablesForTenant}, which walks the dependency order.
 */
export async function seedRow(
  db: Database,
  table: (typeof TENANT_SCOPED_TABLES)[number],
  tenantId: string,
  ctx: SeedCtx,
): Promise<void> {
  const name = getTableConfig(table).name;

  switch (name) {
    case 'members': {
      const [r] = await db
        .insert(members)
        .values({ tenantId, displayName: `member-${tenantId.slice(0, 4)}` })
        .returning();
      ctx.memberId = r!.id;
      break;
    }
    case 'pending_invitations': {
      await db.insert(pendingInvitations).values({
        tenantId,
        email: `invitee-${tenantId.slice(0, 4)}@example.com`,
        role: 'adult',
        invitedBy: ctx.memberId!,
      });
      break;
    }
    case 'rewards': {
      const [r] = await db
        .insert(rewards)
        .values({ tenantId, name: `reward-${tenantId.slice(0, 4)}`, stickerCost: 5 })
        .returning();
      ctx.rewardId = r!.id;
      break;
    }
    case 'meal_templates': {
      await db.insert(mealTemplates).values({
        tenantId,
        dayOfWeek: 'mon',
        slot: 'breakfast',
        name: `meal-${tenantId.slice(0, 4)}`,
      });
      break;
    }
    case 'events': {
      await db.insert(events).values({
        tenantId,
        date: '2026-01-06',
        title: `event-${tenantId.slice(0, 4)}`,
      });
      break;
    }
    case 'assignments': {
      await db.insert(assignments).values({
        tenantId,
        title: `assignment-${tenantId.slice(0, 4)}`,
        dueDate: '2026-01-10',
      });
      break;
    }
    case 'notices': {
      await db.insert(notices).values({
        tenantId,
        body: `notice-${tenantId.slice(0, 4)}`,
      });
      break;
    }
    case 'tasks': {
      await db.insert(tasks).values({
        tenantId,
        memberId: ctx.memberId!,
        title: `task-${tenantId.slice(0, 4)}`,
      });
      break;
    }
    case 'weeks': {
      const [r] = await db
        .insert(weeks)
        .values({ tenantId, startDate: '2026-01-06', endDate: '2026-01-12' })
        .returning();
      ctx.weekId = r!.id;
      break;
    }
    case 'habits': {
      const [r] = await db
        .insert(habits)
        .values({ tenantId, name: `habit-${tenantId.slice(0, 4)}` })
        .returning();
      ctx.habitId = r!.id;
      break;
    }
    case 'habit_logs': {
      await db.insert(habitLogs).values({
        tenantId,
        habitId: ctx.habitId!,
        memberId: ctx.memberId!,
        logDate: '2026-01-06',
      });
      break;
    }
    case 'reward_redemptions': {
      await db.insert(rewardRedemptions).values({
        tenantId,
        rewardId: ctx.rewardId!,
        memberId: ctx.memberId!,
        stickerCost: 5,
      });
      break;
    }
    case 'redemption_requests': {
      await db.insert(redemptionRequests).values({
        tenantId,
        rewardId: ctx.rewardId!,
        memberId: ctx.memberId!,
        starCost: 5,
      });
      break;
    }
    case 'journal_entries': {
      await db.insert(journalEntries).values({
        tenantId,
        memberId: ctx.memberId!,
        entryDate: '2026-06-15',
        body: `journal-${tenantId.slice(0, 4)}`,
      });
      break;
    }
    case 'learn_progress': {
      await db.insert(learnProgress).values({
        tenantId,
        memberId: ctx.memberId!,
        subject: 'Maths',
        progress: 10,
      });
      break;
    }
    case 'reading_log': {
      await db.insert(readingLog).values({
        tenantId,
        memberId: ctx.memberId!,
        title: `book-${tenantId.slice(0, 4)}`,
      });
      break;
    }
    case 'world_flags_progress': {
      await db.insert(worldFlagsProgress).values({
        tenantId,
        memberId: ctx.memberId!,
        countryCode: 'GB',
      });
      break;
    }
    case 'world_flags_learn_progress': {
      await db.insert(worldFlagsLearnProgress).values({
        tenantId,
        memberId: ctx.memberId!,
        continent: 'Africa',
        chunkIndex: 0,
      });
      break;
    }
    case 'mw_weeks': {
      const [r] = await db
        .insert(mwWeeks)
        .values({
          tenantId,
          memberId: ctx.memberId!,
          weekNumber: 1,
          year: 2026,
          startDate: '2026-01-05',
        })
        .returning();
      ctx.mwWeekId = r!.id;
      break;
    }
    case 'habit_stickers': {
      await db.insert(habitStickers).values({
        tenantId,
        memberId: ctx.memberId!,
        habitId: ctx.habitId!,
        weekId: ctx.mwWeekId!,
        day: 0,
        sticker: 'gold-star',
        stickerValue: 1,
      });
      break;
    }
    case 'mw_savings': {
      await db.insert(mwSavings).values({
        tenantId,
        memberId: ctx.memberId!,
        savedStickers: 5,
      });
      break;
    }
    case 'mw_savings_transactions': {
      await db.insert(mwSavingsTransactions).values({
        tenantId,
        memberId: ctx.memberId!,
        transactionType: 'stickers',
        amount: '5',
        stickerCount: 5,
      });
      break;
    }
    case 'mw_investments': {
      await db.insert(mwInvestments).values({
        tenantId,
        memberId: ctx.memberId!,
        habitId: ctx.habitId!,
        weekId: ctx.mwWeekId!,
        investedAmount: '5',
        investedStickers: 10,
        originalInvestedStickers: 10,
      });
      break;
    }
    case 'mw_week_actions': {
      await db.insert(mwWeekActions).values({
        tenantId,
        memberId: ctx.memberId!,
        weekId: ctx.mwWeekId!,
        actionType: 'save',
        stickersUsed: 5,
      });
      break;
    }
    case 'week_actions': {
      await db.insert(weekActions).values({
        tenantId,
        weekId: ctx.weekId!,
        memberId: ctx.memberId!,
        habitId: ctx.habitId!,
        completedCount: 1,
      });
      break;
    }
    case 'savings': {
      const [r] = await db
        .insert(savings)
        .values({ tenantId, name: `fund-${tenantId.slice(0, 4)}` })
        .returning();
      ctx.savingsId = r!.id;
      break;
    }
    case 'savings_transactions': {
      await db.insert(savingsTransactions).values({
        tenantId,
        savingsId: ctx.savingsId!,
        amount: '10.00',
        type: 'deposit',
        occurredOn: '2026-01-06',
      });
      break;
    }
    case 'investments': {
      await db.insert(investments).values({
        tenantId,
        name: `inv-${tenantId.slice(0, 4)}`,
        assetType: 'stock',
      });
      break;
    }
    case 'app_settings': {
      await db.insert(appSettings).values({
        tenantId,
        key: 'theme',
        value: '"dark"',
      });
      break;
    }
    case 'activity_logs': {
      await db.insert(activityLogs).values({
        tenantId,
        action: `seed-${tenantId.slice(0, 4)}`,
      });
      break;
    }
    case 'beta_feedback': {
      await db.insert(betaFeedback).values({
        tenantId,
        painPoint: `seed-pain-${tenantId.slice(0, 4)}`,
      });
      break;
    }
    case 'mw_maths_progress': {
      await db.insert(mwMathsProgress).values({
        tenantId,
        memberId: ctx.memberId!,
        operation: 'addition',
        tableNumber: 1,
      });
      break;
    }
    case 'mw_maths_certificates': {
      await db.insert(mwMathsCertificates).values({
        tenantId,
        memberId: ctx.memberId!,
        operation: 'addition',
        difficulty: '1',
        totalCorrect: 10,
      });
      break;
    }
    case 'mw_logic_progress': {
      await db.insert(mwLogicProgress).values({
        tenantId,
        memberId: ctx.memberId!,
        gameType: 'truefalse',
        difficulty: 'easy',
        correctCount: 0,
      });
      break;
    }
    case 'mw_logic_certificates': {
      await db.insert(mwLogicCertificates).values({
        tenantId,
        memberId: ctx.memberId!,
        gameType: 'truefalse',
        difficulty: 'easy',
        totalCorrect: 10,
      });
      break;
    }
    default:
      throw new Error(`seedRow: unknown table "${name}"`);
  }
}

// Dependency order — parents before children (week_actions needs member + week
// + habit; savings_transactions needs savings; etc.).
const DEPENDENCY_ORDER = [
  'members',
  'pending_invitations',
  'weeks',
  'habits',
  'rewards',
  'meal_templates',
  'events',
  'assignments',
  'notices',
  'tasks',
  'habit_logs',
  'reward_redemptions',
  'redemption_requests',
  'journal_entries',
  'learn_progress',
  'reading_log',
  'world_flags_progress',
  'world_flags_learn_progress',
  'mw_weeks',
  'habit_stickers',
  'mw_savings',
  'mw_savings_transactions',
  'mw_investments',
  'mw_week_actions',
  'mw_maths_progress',
  'mw_maths_certificates',
  'mw_logic_progress',
  'mw_logic_certificates',
  'savings',
  'week_actions',
  'savings_transactions',
  'investments',
  'app_settings',
  'activity_logs',
  'beta_feedback',
] as const;

/** Seed one fixture row per tenant-scoped table for `tenantId`, FK-ordered. */
export async function seedAllTablesForTenant(db: Database, tenantId: string): Promise<void> {
  const ctx: SeedCtx = {};
  const tableMap = new Map(TENANT_SCOPED_TABLES.map((t) => [getTableConfig(t).name, t]));
  for (const name of DEPENDENCY_ORDER) {
    const table = tableMap.get(name);
    if (!table) throw new Error(`seed-tenant-tables: table "${name}" not in registry`);
    await seedRow(db, table, tenantId, ctx);
  }
}
