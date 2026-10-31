// FHS-664: gathers the per-area OpenAPI entries merged into ../registry.ts.
import type { RouteMeta } from '../registry.js';
import { moneyMeta } from './money.js';
import { peopleMeta } from './people.js';
import { plannerMeta } from './planner.js';
import { tasksHabitsMeta } from './tasks-habits.js';

export const areaMeta: Record<string, RouteMeta> = {
  ...tasksHabitsMeta,
  ...plannerMeta,
  ...peopleMeta,
  ...moneyMeta,
};
