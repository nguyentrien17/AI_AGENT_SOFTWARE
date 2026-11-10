import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { aiModels } from './ai.js';
import { createdAt, id, updatedAt, version } from './columns.js';
import { workspaces } from './iam.js';

export const budgetLevel = pgEnum('budget_level', [
  'system',
  'project',
  'workflow',
  'task',
  'invocation',
]);

export const budgetThresholdBand = pgEnum('budget_threshold_band', [
  'normal',
  'optimize_50',
  'warning_70',
  'restrict_85',
  'halt_95',
  'exhausted_100',
]);

export interface BudgetThresholdsConfig {
  optimizePct: number;
  warningPct: number;
  restrictPct: number;
  haltPct: number;
}

export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholdsConfig = {
  optimizePct: 50,
  warningPct: 70,
  restrictPct: 85,
  haltPct: 95,
};

/**
 * Multi-tier token & cost budgets (Blueprint §10.1 & §10.4).
 */
export const tokenBudgets = pgTable(
  'token_budgets',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    level: budgetLevel('level').notNull(),
    scopeRefId: uuid('scope_ref_id'),
    scopeKey: text('scope_key').notNull(),
    tokenLimit: bigint('token_limit', { mode: 'number' }),
    costLimitUsd: numeric('cost_limit_usd', { precision: 14, scale: 6 }),
    currency: text('currency').notNull().default('USD'),
    consumedTokens: bigint('consumed_tokens', { mode: 'number' }).notNull().default(0),
    consumedCostUsd: numeric('consumed_cost_usd', { precision: 14, scale: 6 })
      .notNull()
      .default('0.000000'),
    currentBand: budgetThresholdBand('current_band').notNull().default('normal'),
    halted: boolean('halted').notNull().default(false),
    lastCheckpointId: uuid('last_checkpoint_id'),
    thresholds: jsonb('thresholds')
      .$type<BudgetThresholdsConfig>()
      .notNull()
      .default(DEFAULT_BUDGET_THRESHOLDS),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('token_budgets_ws_level_scope_uq').on(t.workspaceId, t.level, t.scopeKey)],
);

/** Append-only ledger of budget threshold crossings and halts (Blueprint §10.4). */
export const budgetEvents = pgTable(
  'budget_events',
  {
    id: id(),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => tokenBudgets.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    previousBand: budgetThresholdBand('previous_band').notNull(),
    newBand: budgetThresholdBand('new_band').notNull(),
    utilizationPct: numeric('utilization_pct', { precision: 7, scale: 2 }).notNull(),
    consumedTokens: bigint('consumed_tokens', { mode: 'number' }).notNull(),
    consumedCostUsd: numeric('consumed_cost_usd', { precision: 14, scale: 6 }).notNull(),
    actionTaken: text('action_taken').notNull(),
    checkpointId: uuid('checkpoint_id'),
    createdAt: createdAt(),
  },
  (t) => [index('budget_events_budget_idx').on(t.budgetId, t.createdAt)],
);

/** Append-only ledger of model fallback events (Blueprint §5.4). */
export const fallbackEvents = pgTable(
  'fallback_events',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    invocationId: uuid('invocation_id'),
    agentKey: text('agent_key').notNull(),
    projectId: uuid('project_id'),
    taskId: uuid('task_id'),
    originalModelId: uuid('original_model_id')
      .notNull()
      .references(() => aiModels.id, { onDelete: 'cascade' }),
    fallbackModelId: uuid('fallback_model_id').references(() => aiModels.id, { onDelete: 'set null' }),
    attemptCount: integer('attempt_count').notNull(),
    triggerKind: text('trigger_kind').notNull(),
    allowed: boolean('allowed').notNull(),
    haltReason: text('halt_reason'),
    createdAt: createdAt(),
  },
  (t) => [index('fallback_events_ws_created_idx').on(t.workspaceId, t.createdAt)],
);
