import type { BudgetHaltHandler } from '@platform/budget';
import { createCheckpoint } from '@platform/context';
import type { Db } from '@platform/db';
import type { StorageAdapter } from '@platform/storage';

/**
 * Hard Budget Exhaustion Protocol (Blueprint §10.4): persist a clean checkpoint of the project the halted
 * budget belongs to. Budgets not tied to a project have nothing to snapshot. Shared by the HTTP routes and
 * the in-process worker.
 */
export function createBudgetHaltHandler(db: Db, storage: StorageAdapter): BudgetHaltHandler {
  return async ({ budget, scope }) => {
    if (!scope.projectId) return null;
    const checkpoint = await createCheckpoint(
      { db, storage },
      { type: 'system', workspaceId: scope.workspaceId, component: 'budget-manager' },
      scope.projectId,
      {
        label: `budget-halt:${budget.level}`,
        extra: {
          reason: 'budget_halt',
          budgetId: budget.id,
          level: budget.level,
          utilizationPct: budget.utilizationPct,
          taskId: scope.taskId ?? null,
          workflowId: scope.workflowId ?? null,
        },
      },
    );
    return checkpoint.id;
  };
}
