import { and, eq, gte, lte } from 'drizzle-orm';
import { aiModels, aiProviders, costRecords, type Db, modelInvocations, tokenUsage } from '@platform/db';
import { authorize } from '@platform/iam';
import { type Actor, ValidationError } from '@platform/shared';

export const COST_GROUP_BY = ['provider', 'model', 'agent', 'project', 'workflow', 'task', 'day'] as const;
export type CostGroupBy = (typeof COST_GROUP_BY)[number];

export interface CostBreakdownFilter {
  providerId?: string;
  modelId?: string;
  agentKey?: string;
  projectId?: string;
  workflowId?: string;
  taskId?: string;
  from?: Date;
  to?: Date;
  groupBy?: CostGroupBy;
}

export interface CostTotals {
  invocations: number;
  succeeded: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: string;
  /** Null unless at least one invocation carries verified billing data — never derived (Blueprint §10.2). */
  actualCostUsd: string | null;
  /** Invocations whose cost could not be estimated (missing pricing or usage). */
  unpricedInvocations: number;
}

export interface CostBreakdown {
  filter: Record<string, string>;
  totals: CostTotals;
  groupBy: CostGroupBy | null;
  groups: Array<{ key: string; label: string } & CostTotals>;
}

interface Acc {
  label: string;
  invocations: number;
  succeeded: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  estimated: number;
  actual: number;
  hasActual: boolean;
  unpriced: number;
}

function emptyAcc(label: string): Acc {
  return {
    label,
    invocations: 0,
    succeeded: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    estimated: 0,
    actual: 0,
    hasActual: false,
    unpriced: 0,
  };
}

function finish(a: Acc): CostTotals {
  return {
    invocations: a.invocations,
    succeeded: a.succeeded,
    failed: a.failed,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    cachedTokens: a.cachedTokens,
    reasoningTokens: a.reasoningTokens,
    estimatedCostUsd: a.estimated.toFixed(6),
    actualCostUsd: a.hasActual ? a.actual.toFixed(6) : null,
    unpricedInvocations: a.unpriced,
  };
}

/**
 * Usage & cost analytics with drill-down filters (Blueprint §4.6-F): provider, model, agent, project,
 * workflow, task and date range, optionally grouped by one dimension.
 */
export async function getCostBreakdown(
  db: Db,
  actor: Actor,
  filter: CostBreakdownFilter = {},
): Promise<CostBreakdown> {
  await authorize(db, actor, 'ai.config.read');
  if (!actor.workspaceId) throw new ValidationError('A workspace context is required');
  if (filter.from && filter.to && filter.from > filter.to) {
    throw new ValidationError("'from' must not be later than 'to'");
  }

  const rows = await db
    .select({
      inv: modelInvocations,
      providerKey: aiProviders.providerKey,
      modelKey: aiModels.modelKey,
      tok: tokenUsage,
      cost: costRecords,
    })
    .from(modelInvocations)
    .innerJoin(aiProviders, eq(modelInvocations.providerId, aiProviders.id))
    .innerJoin(aiModels, eq(modelInvocations.modelId, aiModels.id))
    .leftJoin(tokenUsage, eq(tokenUsage.invocationId, modelInvocations.id))
    .leftJoin(costRecords, eq(costRecords.invocationId, modelInvocations.id))
    .where(
      and(
        eq(modelInvocations.workspaceId, actor.workspaceId),
        filter.providerId ? eq(modelInvocations.providerId, filter.providerId) : undefined,
        filter.modelId ? eq(modelInvocations.modelId, filter.modelId) : undefined,
        filter.agentKey ? eq(modelInvocations.agentKey, filter.agentKey.toLowerCase()) : undefined,
        filter.projectId ? eq(modelInvocations.projectId, filter.projectId) : undefined,
        filter.workflowId ? eq(modelInvocations.workflowId, filter.workflowId) : undefined,
        filter.taskId ? eq(modelInvocations.taskId, filter.taskId) : undefined,
        filter.from ? gte(modelInvocations.createdAt, filter.from) : undefined,
        filter.to ? lte(modelInvocations.createdAt, filter.to) : undefined,
      ),
    );

  const total = emptyAcc('total');
  const groups = new Map<string, Acc>();
  const keyOf = (r: (typeof rows)[number]): { key: string; label: string } => {
    switch (filter.groupBy) {
      case 'provider':
        return { key: r.inv.providerId, label: r.providerKey };
      case 'model':
        return { key: r.inv.modelId, label: r.modelKey };
      case 'agent':
        return { key: r.inv.agentKey ?? '__unassigned__', label: r.inv.agentKey ?? '(none)' };
      case 'project':
        return { key: r.inv.projectId ?? '__none__', label: r.inv.projectId ?? '(none)' };
      case 'workflow':
        return { key: r.inv.workflowId ?? '__none__', label: r.inv.workflowId ?? '(none)' };
      case 'task':
        return { key: r.inv.taskId ?? '__none__', label: r.inv.taskId ?? '(none)' };
      default: {
        const day = r.inv.createdAt.toISOString().slice(0, 10);
        return { key: day, label: day };
      }
    }
  };

  for (const r of rows) {
    const targets = [total];
    if (filter.groupBy) {
      const { key, label } = keyOf(r);
      let g = groups.get(key);
      if (!g) {
        g = emptyAcc(label);
        groups.set(key, g);
      }
      targets.push(g);
    }
    for (const a of targets) {
      a.invocations++;
      if (r.inv.status === 'succeeded') a.succeeded++;
      else a.failed++;
      a.inputTokens += r.tok?.inputTokens ?? 0;
      a.outputTokens += r.tok?.outputTokens ?? 0;
      a.cachedTokens += r.tok?.cachedTokens ?? 0;
      a.reasoningTokens += r.tok?.reasoningTokens ?? 0;
      if (r.cost?.estimatedCost != null) a.estimated += Number(r.cost.estimatedCost);
      else if (r.inv.status === 'succeeded') a.unpriced++;
      if (r.cost?.actualCost != null) {
        a.actual += Number(r.cost.actualCost);
        a.hasActual = true;
      }
    }
  }

  const applied: Record<string, string> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined && k !== 'groupBy') applied[k] = v instanceof Date ? v.toISOString() : String(v);
  }

  return {
    filter: applied,
    totals: finish(total),
    groupBy: filter.groupBy ?? null,
    groups: [...groups.entries()]
      .map(([key, a]) => ({ key, label: a.label, ...finish(a) }))
      .sort((a, b) => Number(b.estimatedCostUsd) - Number(a.estimatedCostUsd) || a.key.localeCompare(b.key)),
  };
}
