import { and, desc, eq, or, sql } from 'drizzle-orm';
import { budgetEvents, type BudgetThresholdsConfig, type Db, tokenBudgets } from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import { type Actor, ForbiddenError, NotFoundError, ValidationError } from '@platform/shared';
import {
  bandAction,
  bandFor,
  bandRank,
  type BudgetBand,
  isHaltBand,
  utilizationPct,
  validateThresholds,
  worstBand,
} from './bands.js';

export type BudgetLevel = 'system' | 'project' | 'workflow' | 'task' | 'invocation';

const SYSTEM_SCOPE_KEY = '__system__';
const INVOCATION_SCOPE_KEY = '__invocation__';

/** Identifies which budgets of the hierarchy apply to a piece of work (Blueprint §10.1). */
export interface BudgetScope {
  workspaceId: string;
  projectId?: string | null;
  workflowId?: string | null;
  taskId?: string | null;
}

export interface BudgetView {
  id: string;
  workspaceId: string;
  level: BudgetLevel;
  scopeRefId: string | null;
  tokenLimit: number | null;
  costLimitUsd: string | null;
  currency: string;
  consumedTokens: number;
  consumedCostUsd: string;
  remainingTokens: number | null;
  remainingCostUsd: string | null;
  utilizationPct: number;
  currentBand: BudgetBand;
  halted: boolean;
  lastCheckpointId: string | null;
  thresholds: BudgetThresholdsConfig;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

type BudgetRow = typeof tokenBudgets.$inferSelect;

function workspaceOf(actor: Actor): string {
  if (!actor.workspaceId) throw new ValidationError('A workspace context is required for budgets');
  return actor.workspaceId;
}

function snapshot(row: BudgetRow) {
  return {
    tokenLimit: row.tokenLimit,
    costLimitUsd: row.costLimitUsd !== null ? Number(row.costLimitUsd) : null,
    consumedTokens: row.consumedTokens,
    consumedCostUsd: Number(row.consumedCostUsd),
  };
}

export function toBudgetView(row: BudgetRow): BudgetView {
  const s = snapshot(row);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    level: row.level,
    scopeRefId: row.scopeRefId,
    tokenLimit: row.tokenLimit,
    costLimitUsd: row.costLimitUsd,
    currency: row.currency,
    consumedTokens: row.consumedTokens,
    consumedCostUsd: row.consumedCostUsd,
    remainingTokens: s.tokenLimit !== null ? Math.max(0, s.tokenLimit - s.consumedTokens) : null,
    remainingCostUsd:
      s.costLimitUsd !== null ? Math.max(0, s.costLimitUsd - s.consumedCostUsd).toFixed(6) : null,
    utilizationPct: utilizationPct(s),
    currentBand: row.currentBand,
    halted: row.halted,
    lastCheckpointId: row.lastCheckpointId,
    thresholds: row.thresholds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function scopeKeyFor(level: BudgetLevel, scopeRefId?: string | null): { scopeRefId: string | null; scopeKey: string } {
  const ref = scopeRefId?.trim() || null;
  if (level === 'system' || level === 'invocation') {
    if (ref) throw new ValidationError(`${level} budget must not specify scopeRefId`);
    return { scopeRefId: null, scopeKey: level === 'system' ? SYSTEM_SCOPE_KEY : INVOCATION_SCOPE_KEY };
  }
  if (!ref) throw new ValidationError(`${level} budget requires scopeRefId`);
  return { scopeRefId: ref, scopeKey: ref };
}

function parseCostLimit(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new ValidationError('costLimitUsd must be a positive decimal with at most 6 decimal places');
  }
  return trimmed;
}

export interface UpsertBudgetInput {
  level: BudgetLevel;
  scopeRefId?: string | null;
  tokenLimit?: number | null;
  costLimitUsd?: string | null;
  thresholds?: Partial<BudgetThresholdsConfig>;
}

/**
 * Creates or changes a budget. Raising a limit is the human approval that lifts a halt (Blueprint §10.4):
 * the band is recomputed against the new limit and the halt flag is cleared once utilisation drops below
 * the halt threshold.
 */
export async function upsertBudget(db: Db, actor: Actor, input: UpsertBudgetInput): Promise<BudgetView> {
  const workspaceId = workspaceOf(actor);
  const { scopeRefId, scopeKey } = scopeKeyFor(input.level, input.scopeRefId);
  const { role } = await authorize(
    db,
    actor,
    'ai.config.manage',
    input.level === 'project' && scopeRefId ? { projectId: scopeRefId } : {},
  );
  if (
    (input.level === 'system' || input.level === 'invocation') &&
    role !== 'owner' &&
    role !== 'administrator' &&
    role !== 'system'
  ) {
    throw new ForbiddenError(`'${input.level}' budgets can only be changed by workspace administrators`);
  }

  const tokenLimit = input.tokenLimit ?? null;
  if (tokenLimit !== null && (!Number.isInteger(tokenLimit) || tokenLimit <= 0)) {
    throw new ValidationError('tokenLimit must be a positive integer');
  }
  const costLimitUsd = parseCostLimit(input.costLimitUsd);
  if (tokenLimit === null && costLimitUsd === null) {
    throw new ValidationError('A budget requires tokenLimit, costLimitUsd, or both');
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(tokenBudgets)
      .where(
        and(
          eq(tokenBudgets.workspaceId, workspaceId),
          eq(tokenBudgets.level, input.level),
          eq(tokenBudgets.scopeKey, scopeKey),
        ),
      )
      .limit(1);

    const thresholds = validateThresholds({ ...(existing?.thresholds ?? {}), ...(input.thresholds ?? {}) });
    let row: BudgetRow;

    if (existing) {
      const pct = utilizationPct({
        tokenLimit,
        costLimitUsd: costLimitUsd !== null ? Number(costLimitUsd) : null,
        consumedTokens: existing.consumedTokens,
        consumedCostUsd: Number(existing.consumedCostUsd),
      });
      const band = bandFor(pct, thresholds);
      const halted = isHaltBand(band);
      const [updated] = await tx
        .update(tokenBudgets)
        .set({
          tokenLimit,
          costLimitUsd,
          thresholds,
          currentBand: band,
          halted,
          updatedAt: new Date(),
          version: existing.version + 1,
        })
        .where(eq(tokenBudgets.id, existing.id))
        .returning();
      row = updated!;
      if (band !== existing.currentBand) {
        await tx.insert(budgetEvents).values({
          budgetId: row.id,
          workspaceId,
          previousBand: existing.currentBand,
          newBand: band,
          utilizationPct: pct.toFixed(2),
          consumedTokens: row.consumedTokens,
          consumedCostUsd: row.consumedCostUsd,
          actionTaken: existing.halted && !halted ? 'limit_changed_halt_lifted' : 'limit_changed',
        });
      }
    } else {
      const [created] = await tx
        .insert(tokenBudgets)
        .values({ workspaceId, level: input.level, scopeRefId, scopeKey, tokenLimit, costLimitUsd, thresholds })
        .returning();
      row = created!;
    }

    await audit(tx, actor, {
      action: existing ? 'budget.updated' : 'budget.created',
      targetType: 'token_budget',
      targetId: row.id,
      projectId: input.level === 'project' ? scopeRefId : null,
      payload: {
        level: row.level,
        scopeRefId: row.scopeRefId,
        before: existing
          ? { tokenLimit: existing.tokenLimit, costLimitUsd: existing.costLimitUsd, halted: existing.halted }
          : null,
        after: { tokenLimit: row.tokenLimit, costLimitUsd: row.costLimitUsd, halted: row.halted },
      },
    });
    await emitEvent(tx, {
      type: existing?.halted && !row.halted ? 'budget.resumed' : 'budget.updated',
      aggregateType: 'token_budget',
      aggregateId: row.id,
      workspaceId,
      payload: { budgetId: row.id, level: row.level, scopeRefId: row.scopeRefId, band: row.currentBand },
    });

    return toBudgetView(row);
  });
}

export async function listBudgets(
  db: Db,
  actor: Actor,
  filter: { level?: BudgetLevel; scopeRefId?: string } = {},
): Promise<BudgetView[]> {
  await authorize(db, actor, 'ai.config.read');
  const workspaceId = workspaceOf(actor);
  const rows = await db
    .select()
    .from(tokenBudgets)
    .where(
      and(
        eq(tokenBudgets.workspaceId, workspaceId),
        filter.level ? eq(tokenBudgets.level, filter.level) : undefined,
        filter.scopeRefId ? eq(tokenBudgets.scopeRefId, filter.scopeRefId) : undefined,
      ),
    )
    .orderBy(tokenBudgets.level, tokenBudgets.scopeKey);
  return rows.map(toBudgetView);
}

export async function listBudgetEvents(db: Db, actor: Actor, budgetId: string) {
  await authorize(db, actor, 'ai.config.read');
  const workspaceId = workspaceOf(actor);
  const [budget] = await db
    .select({ id: tokenBudgets.id })
    .from(tokenBudgets)
    .where(and(eq(tokenBudgets.id, budgetId), eq(tokenBudgets.workspaceId, workspaceId)))
    .limit(1);
  if (!budget) throw new NotFoundError('Budget', budgetId);
  return db
    .select()
    .from(budgetEvents)
    .where(eq(budgetEvents.budgetId, budgetId))
    .orderBy(desc(budgetEvents.createdAt), desc(budgetEvents.id));
}

/** Loads every budget of the hierarchy that covers the given scope, widest first. */
export async function findApplicableBudgets(db: Db, scope: BudgetScope): Promise<BudgetRow[]> {
  const clauses = [
    and(eq(tokenBudgets.level, 'system'), eq(tokenBudgets.scopeKey, SYSTEM_SCOPE_KEY)),
    and(eq(tokenBudgets.level, 'invocation'), eq(tokenBudgets.scopeKey, INVOCATION_SCOPE_KEY)),
  ];
  if (scope.projectId) {
    clauses.push(and(eq(tokenBudgets.level, 'project'), eq(tokenBudgets.scopeKey, scope.projectId)));
  }
  if (scope.workflowId) {
    clauses.push(and(eq(tokenBudgets.level, 'workflow'), eq(tokenBudgets.scopeKey, scope.workflowId)));
  }
  if (scope.taskId) {
    clauses.push(and(eq(tokenBudgets.level, 'task'), eq(tokenBudgets.scopeKey, scope.taskId)));
  }
  const order: BudgetLevel[] = ['system', 'project', 'workflow', 'task', 'invocation'];
  const rows = await db
    .select()
    .from(tokenBudgets)
    .where(and(eq(tokenBudgets.workspaceId, scope.workspaceId), or(...clauses)));
  return rows.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
}

export type BudgetBlockReason =
  | 'budget_halted'
  | 'budget_exhausted'
  | 'budget_would_be_exceeded'
  | 'invocation_limit_exceeded'
  | 'budget_restricted_non_essential';

export interface BudgetEstimate {
  /** Worst-case tokens the invocation may consume (input + max output). */
  estimatedTokens: number;
  /** Null when no pricing metadata exists; cost limits then cannot be pre-checked and are enforced after the fact. */
  estimatedCostUsd: number | null;
  /** Mandatory verification / testing work keeps running in the restrict band (Blueprint §10.4). */
  essential?: boolean;
}

export interface BudgetDecision {
  allowed: boolean;
  reason: BudgetBlockReason | null;
  blockingBudgetId: string | null;
  blockingLevel: BudgetLevel | null;
  worstBand: BudgetBand;
  /** True from the 50% band: callers must prune context and prefer cached packages (Blueprint §10.4). */
  optimizeContext: boolean;
  /** Tightest remaining headroom across the hierarchy; null when no budget limits that dimension. */
  remainingTokens: number | null;
  remainingCostUsd: number | null;
  notes: string[];
  budgets: BudgetView[];
}

/**
 * Pre-flight budget check for one invocation. Never mutates state. Blocks rather than silently degrading
 * quality: a blocked invocation is reported to the caller, which must pause and ask a human
 * (Blueprint §10.4 Hard Budget Exhaustion Protocol).
 */
export async function checkBudgets(db: Db, scope: BudgetScope, estimate: BudgetEstimate): Promise<BudgetDecision> {
  const rows = await findApplicableBudgets(db, scope);
  const views = rows.map(toBudgetView);
  const notes: string[] = [];
  let remainingTokens: number | null = null;
  let remainingCostUsd: number | null = null;
  let block: { reason: BudgetBlockReason; row: BudgetRow } | null = null;
  const fail = (reason: BudgetBlockReason, row: BudgetRow) => {
    block ??= { reason, row };
  };

  for (const row of rows) {
    const s = snapshot(row);
    if (row.level === 'invocation') {
      if (s.tokenLimit !== null && estimate.estimatedTokens > s.tokenLimit) fail('invocation_limit_exceeded', row);
      if (s.costLimitUsd !== null) {
        if (estimate.estimatedCostUsd === null) notes.push('invocation_cost_limit_unchecked_no_pricing');
        else if (estimate.estimatedCostUsd > s.costLimitUsd) fail('invocation_limit_exceeded', row);
      }
      continue;
    }

    if (s.tokenLimit !== null) {
      const left = Math.max(0, s.tokenLimit - s.consumedTokens);
      remainingTokens = remainingTokens === null ? left : Math.min(remainingTokens, left);
    }
    if (s.costLimitUsd !== null) {
      const left = Math.max(0, s.costLimitUsd - s.consumedCostUsd);
      remainingCostUsd = remainingCostUsd === null ? left : Math.min(remainingCostUsd, left);
    }

    const band = bandFor(utilizationPct(s), row.thresholds);
    if (band === 'exhausted_100') fail('budget_exhausted', row);
    else if (row.halted || band === 'halt_95') fail('budget_halted', row);
    else if (band === 'restrict_85' && !estimate.essential) fail('budget_restricted_non_essential', row);
    else if (s.tokenLimit !== null && s.consumedTokens + estimate.estimatedTokens > s.tokenLimit) {
      fail('budget_would_be_exceeded', row);
    } else if (s.costLimitUsd !== null) {
      if (estimate.estimatedCostUsd === null) notes.push(`${row.level}_cost_limit_unchecked_no_pricing`);
      else if (s.consumedCostUsd + estimate.estimatedCostUsd > s.costLimitUsd) fail('budget_would_be_exceeded', row);
    }
  }

  const accumulating = rows.filter((r) => r.level !== 'invocation');
  const worst = worstBand(accumulating.map((r) => bandFor(utilizationPct(snapshot(r)), r.thresholds)));
  const blocked = block as { reason: BudgetBlockReason; row: BudgetRow } | null;
  return {
    allowed: blocked === null,
    reason: blocked?.reason ?? null,
    blockingBudgetId: blocked?.row.id ?? null,
    blockingLevel: blocked?.row.level ?? null,
    worstBand: worst,
    optimizeContext: bandRank(worst) >= bandRank('optimize_50'),
    remainingTokens,
    remainingCostUsd,
    notes: [...new Set(notes)],
    budgets: views,
  };
}

export interface BudgetHaltInfo {
  budget: BudgetView;
  scope: BudgetScope;
}

/** Saves a clean checkpoint when a budget halts and returns its id (wired to the context engine by the host app). */
export type BudgetHaltHandler = (info: BudgetHaltInfo) => Promise<string | null>;

export interface BudgetTransition {
  budgetId: string;
  level: BudgetLevel;
  previousBand: BudgetBand;
  newBand: BudgetBand;
  utilizationPct: number;
  action: string;
  haltTriggered: boolean;
  checkpointId: string | null;
}

export interface ConsumptionResult {
  transitions: BudgetTransition[];
  haltTriggered: boolean;
  worstBand: BudgetBand;
}

/**
 * Charges actual usage to every budget covering the scope and applies the threshold protocol
 * (Blueprint §10.4). Each band crossing is appended to `budget_events`; entering the halt band flags the
 * budget as halted, saves a checkpoint through `onHalt` and emits `budget.halted` so a human can raise
 * the limit or reduce scope.
 */
export async function recordConsumption(
  db: Db,
  actor: Actor,
  scope: BudgetScope,
  usage: { tokens: number; costUsd: number | null },
  opts: { onHalt?: BudgetHaltHandler } = {},
): Promise<ConsumptionResult> {
  const tokens = Math.max(0, Math.trunc(usage.tokens));
  const cost = usage.costUsd !== null ? Math.max(0, usage.costUsd) : 0;
  const applicable = (await findApplicableBudgets(db, scope)).filter((r) => r.level !== 'invocation');
  const transitions: BudgetTransition[] = [];
  const bands: BudgetBand[] = [];

  for (const before of applicable) {
    const crossed = await db.transaction(async (tx) => {
      const [charged] = await tx
        .update(tokenBudgets)
        .set({
          consumedTokens: sql`${tokenBudgets.consumedTokens} + ${tokens}`,
          consumedCostUsd: sql`${tokenBudgets.consumedCostUsd} + ${cost.toFixed(6)}::numeric`,
          updatedAt: new Date(),
        })
        .where(eq(tokenBudgets.id, before.id))
        .returning();
      const row = charged!;
      const pct = utilizationPct(snapshot(row));
      const band = bandFor(pct, row.thresholds);
      bands.push(band);
      if (band === before.currentBand) return null;

      const haltTriggered = isHaltBand(band) && !before.halted;
      const [updated] = await tx
        .update(tokenBudgets)
        .set({ currentBand: band, halted: before.halted || isHaltBand(band) })
        .where(eq(tokenBudgets.id, row.id))
        .returning();
      // The halt event is appended after the checkpoint exists so it can reference it.
      if (!haltTriggered) {
        await tx.insert(budgetEvents).values({
          budgetId: row.id,
          workspaceId: row.workspaceId,
          previousBand: before.currentBand,
          newBand: band,
          utilizationPct: pct.toFixed(2),
          consumedTokens: row.consumedTokens,
          consumedCostUsd: row.consumedCostUsd,
          actionTaken: bandAction(band),
        });
        await emitEvent(tx, {
          type: 'budget.threshold_crossed',
          aggregateType: 'token_budget',
          aggregateId: row.id,
          workspaceId: row.workspaceId,
          projectId: scope.projectId ?? null,
          payload: { budgetId: row.id, level: row.level, band, utilizationPct: pct, action: bandAction(band) },
        });
      }
      return { row: updated!, pct, band, haltTriggered };
    });
    if (!crossed) continue;

    let checkpointId: string | null = null;
    if (crossed.haltTriggered) {
      let checkpointError: string | null = null;
      if (opts.onHalt) {
        try {
          checkpointId = await opts.onHalt({ budget: toBudgetView(crossed.row), scope });
        } catch (err) {
          checkpointError = err instanceof Error ? err.message : String(err);
        }
      }
      await db.transaction(async (tx) => {
        if (checkpointId) {
          await tx.update(tokenBudgets).set({ lastCheckpointId: checkpointId }).where(eq(tokenBudgets.id, crossed.row.id));
        }
        await tx.insert(budgetEvents).values({
          budgetId: crossed.row.id,
          workspaceId: crossed.row.workspaceId,
          previousBand: before.currentBand,
          newBand: crossed.band,
          utilizationPct: crossed.pct.toFixed(2),
          consumedTokens: crossed.row.consumedTokens,
          consumedCostUsd: crossed.row.consumedCostUsd,
          actionTaken: checkpointId ? bandAction(crossed.band) : `${bandAction(crossed.band)}:no_checkpoint`,
          checkpointId,
        });
        await audit(tx, actor, {
          action: 'budget.halted',
          targetType: 'token_budget',
          targetId: crossed.row.id,
          projectId: scope.projectId ?? null,
          payload: {
            level: crossed.row.level,
            band: crossed.band,
            utilizationPct: crossed.pct,
            checkpointId,
            checkpointError,
            required: 'human_budget_approval',
          },
        });
        await emitEvent(tx, {
          type: 'budget.halted',
          aggregateType: 'token_budget',
          aggregateId: crossed.row.id,
          workspaceId: crossed.row.workspaceId,
          projectId: scope.projectId ?? null,
          payload: {
            budgetId: crossed.row.id,
            level: crossed.row.level,
            band: crossed.band,
            utilizationPct: crossed.pct,
            checkpointId,
            taskId: scope.taskId ?? null,
            workflowId: scope.workflowId ?? null,
          },
        });
      });
    }

    transitions.push({
      budgetId: crossed.row.id,
      level: crossed.row.level,
      previousBand: before.currentBand,
      newBand: crossed.band,
      utilizationPct: crossed.pct,
      action: bandAction(crossed.band),
      haltTriggered: crossed.haltTriggered,
      checkpointId,
    });
  }

  return {
    transitions,
    haltTriggered: transitions.some((t) => t.haltTriggered),
    worstBand: worstBand(bands),
  };
}
