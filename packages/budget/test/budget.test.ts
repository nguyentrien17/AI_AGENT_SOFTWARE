import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { auditLogs, budgetEvents, createTestDatabase, type DatabaseConnection, systemEvents } from '@platform/db';
import { bootstrapOwner } from '@platform/iam';
import { type Actor, uuidv7 } from '@platform/shared';
import {
  bandAction,
  bandFor,
  checkBudgets,
  listBudgetEvents,
  listBudgets,
  recordConsumption,
  upsertBudget,
  utilizationPct,
  validateThresholds,
} from '../src/index.js';

describe('budget bands (Blueprint §10.4) — pure logic', () => {
  it('maps utilisation to the five alert bands plus exhaustion', () => {
    const cases: Array<[number, string]> = [
      [0, 'normal'],
      [49.99, 'normal'],
      [50, 'optimize_50'],
      [69.99, 'optimize_50'],
      [70, 'warning_70'],
      [84.99, 'warning_70'],
      [85, 'restrict_85'],
      [94.99, 'restrict_85'],
      [95, 'halt_95'],
      [99.99, 'halt_95'],
      [100, 'exhausted_100'],
      [140, 'exhausted_100'],
    ];
    for (const [pct, band] of cases) expect(bandFor(pct), `pct=${pct}`).toBe(band);
  });

  it('honours custom thresholds and rejects invalid ones', () => {
    const t = validateThresholds({ optimizePct: 20, warningPct: 40, restrictPct: 60, haltPct: 80 });
    expect(bandFor(45, t)).toBe('warning_70');
    expect(bandFor(80, t)).toBe('halt_95');
    expect(() => validateThresholds({ warningPct: 40 })).toThrow(/ascending/);
    expect(() => validateThresholds({ haltPct: 100 })).toThrow(/below 100/);
  });

  it('uses the more constrained of the token and cost dimensions', () => {
    expect(
      utilizationPct({ tokenLimit: 1000, costLimitUsd: 10, consumedTokens: 100, consumedCostUsd: 9 }),
    ).toBe(90);
    expect(utilizationPct({ tokenLimit: null, costLimitUsd: null, consumedTokens: 5, consumedCostUsd: 5 })).toBe(0);
    expect(bandAction('halt_95')).toBe('halt_and_checkpoint');
  });
});

describe('budget manager (P4-08) — hierarchy, thresholds, halt + checkpoint', () => {
  let conn: DatabaseConnection;
  let owner: Actor;
  let workspaceId: string;
  const workflowId = uuidv7();
  const taskId = uuidv7();

  beforeAll(async () => {
    conn = await createTestDatabase();
    const b = await bootstrapOwner(conn.db, {
      email: 'budget-admin@example.com',
      password: 'Password-12345!',
      displayName: 'Budget Admin',
    });
    workspaceId = b.workspaceId;
    owner = { type: 'user', userId: b.user.id, workspaceId };
  });

  afterAll(async () => conn.close());

  it('validates input and keeps one budget per level + scope', async () => {
    await expect(upsertBudget(conn.db, owner, { level: 'system' })).rejects.toThrow(/requires tokenLimit/);
    await expect(upsertBudget(conn.db, owner, { level: 'task', tokenLimit: 10 })).rejects.toThrow(/scopeRefId/);
    await expect(
      upsertBudget(conn.db, owner, { level: 'system', scopeRefId: uuidv7(), tokenLimit: 10 }),
    ).rejects.toThrow(/must not specify/);
    await expect(
      upsertBudget(conn.db, owner, { level: 'system', costLimitUsd: '-1' }),
    ).rejects.toThrow(/positive decimal/);

    const system = await upsertBudget(conn.db, owner, { level: 'system', tokenLimit: 1_000_000 });
    const again = await upsertBudget(conn.db, owner, { level: 'system', tokenLimit: 1_000_000, costLimitUsd: '100' });
    expect(again.id).toBe(system.id);
    expect(again.version).toBe(2);
    expect((await listBudgets(conn.db, owner, { level: 'system' })).length).toBe(1);
  });

  it('pre-checks the whole hierarchy and reports the tightest headroom', async () => {
    await upsertBudget(conn.db, owner, { level: 'workflow', scopeRefId: workflowId, tokenLimit: 10_000 });
    await upsertBudget(conn.db, owner, { level: 'task', scopeRefId: taskId, tokenLimit: 2_000, costLimitUsd: '1' });
    await upsertBudget(conn.db, owner, { level: 'invocation', tokenLimit: 1_500 });
    const scope = { workspaceId, workflowId, taskId };

    const ok = await checkBudgets(conn.db, scope, { estimatedTokens: 1_000, estimatedCostUsd: 0.1 });
    expect(ok.allowed).toBe(true);
    expect(ok.remainingTokens).toBe(2_000);
    expect(ok.remainingCostUsd).toBe(1);
    expect(ok.budgets.map((b) => b.level)).toEqual(['system', 'workflow', 'task', 'invocation']);

    const perCall = await checkBudgets(conn.db, scope, { estimatedTokens: 1_800, estimatedCostUsd: 0.1 });
    expect(perCall).toMatchObject({ allowed: false, reason: 'invocation_limit_exceeded', blockingLevel: 'invocation' });

    const tooCostly = await checkBudgets(conn.db, scope, { estimatedTokens: 500, estimatedCostUsd: 1.5 });
    expect(tooCostly).toMatchObject({ allowed: false, reason: 'budget_would_be_exceeded', blockingLevel: 'task' });

    const noPricing = await checkBudgets(conn.db, scope, { estimatedTokens: 500, estimatedCostUsd: null });
    expect(noPricing.allowed).toBe(true);
    expect(noPricing.notes).toContain('task_cost_limit_unchecked_no_pricing');

    // A scope outside the task/workflow is only bound by the system + invocation budgets.
    const other = await checkBudgets(conn.db, { workspaceId }, { estimatedTokens: 1_000, estimatedCostUsd: 0 });
    expect(other.budgets.map((b) => b.level)).toEqual(['system', 'invocation']);
  });

  it('walks every threshold band, restricts non-essential work, then halts with a checkpoint', async () => {
    const scope = { workspaceId, workflowId, taskId };
    const checkpointId = uuidv7();
    const haltCalls: string[] = [];
    const onHalt = async (info: { budget: { level: string } }) => {
      haltCalls.push(info.budget.level);
      return checkpointId;
    };
    const taskBudget = async () =>
      (await listBudgets(conn.db, owner, { level: 'task', scopeRefId: taskId }))[0]!;

    // 0 → 55% of the 2 000-token task budget
    let r = await recordConsumption(conn.db, owner, scope, { tokens: 1_100, costUsd: 0.1 }, { onHalt });
    expect(r.transitions.map((t) => [t.level, t.newBand, t.action])).toEqual([
      ['task', 'optimize_50', 'enable_context_optimization'],
    ]);
    expect((await checkBudgets(conn.db, scope, { estimatedTokens: 100, estimatedCostUsd: 0 })).optimizeContext).toBe(true);

    // → 75%
    r = await recordConsumption(conn.db, owner, scope, { tokens: 400, costUsd: 0.1 }, { onHalt });
    expect(r.transitions[0]).toMatchObject({ level: 'task', newBand: 'warning_70', action: 'emit_budget_warning' });

    // → 90%: non-essential work is blocked, verification work keeps running
    r = await recordConsumption(conn.db, owner, scope, { tokens: 300, costUsd: 0.1 }, { onHalt });
    expect(r.transitions[0]).toMatchObject({ newBand: 'restrict_85', action: 'restrict_non_essential', haltTriggered: false });
    expect(await checkBudgets(conn.db, scope, { estimatedTokens: 50, estimatedCostUsd: 0 })).toMatchObject({
      allowed: false,
      reason: 'budget_restricted_non_essential',
    });
    expect(
      (await checkBudgets(conn.db, scope, { estimatedTokens: 50, estimatedCostUsd: 0, essential: true })).allowed,
    ).toBe(true);
    expect(haltCalls).toEqual([]);

    // → 96%: halt, checkpoint, human approval required
    r = await recordConsumption(conn.db, owner, scope, { tokens: 120, costUsd: 0.1 }, { onHalt });
    expect(r.haltTriggered).toBe(true);
    expect(r.transitions[0]).toMatchObject({ newBand: 'halt_95', haltTriggered: true, checkpointId });
    expect(haltCalls).toEqual(['task']);
    expect(await taskBudget()).toMatchObject({ halted: true, currentBand: 'halt_95', lastCheckpointId: checkpointId });
    expect(
      await checkBudgets(conn.db, scope, { estimatedTokens: 10, estimatedCostUsd: 0, essential: true }),
    ).toMatchObject({ allowed: false, reason: 'budget_halted', blockingLevel: 'task' });

    const events = await listBudgetEvents(conn.db, owner, (await taskBudget()).id);
    expect(events.map((e) => e.newBand).reverse()).toEqual(['optimize_50', 'warning_70', 'restrict_85', 'halt_95']);
    expect(events[0]).toMatchObject({ actionTaken: 'halt_and_checkpoint', checkpointId });

    const halts = await conn.db.select().from(systemEvents).where(eq(systemEvents.type, 'budget.halted'));
    expect(halts.length).toBe(1);
    const audits = await conn.db.select().from(auditLogs).where(eq(auditLogs.action, 'budget.halted'));
    expect(audits[0]!.payload).toMatchObject({ required: 'human_budget_approval', checkpointId });

    // The wider budgets were charged too but stayed in their own (lower) bands.
    const workflow = (await listBudgets(conn.db, owner, { level: 'workflow' }))[0]!;
    expect(workflow).toMatchObject({ consumedTokens: 1_920, currentBand: 'normal', halted: false });
  });

  it('reports hard exhaustion and lifts the halt only when a human raises the limit', async () => {
    const scope = { workspaceId, workflowId, taskId };
    const r = await recordConsumption(conn.db, owner, scope, { tokens: 200, costUsd: 0 });
    expect(r.transitions[0]).toMatchObject({ newBand: 'exhausted_100', action: 'hard_stop', haltTriggered: false });
    expect(await checkBudgets(conn.db, scope, { estimatedTokens: 1, estimatedCostUsd: 0 })).toMatchObject({
      allowed: false,
      reason: 'budget_exhausted',
    });

    const raised = await upsertBudget(conn.db, owner, { level: 'task', scopeRefId: taskId, tokenLimit: 10_000 });
    expect(raised).toMatchObject({ halted: false, currentBand: 'normal', consumedTokens: 2_120 });
    expect((await checkBudgets(conn.db, scope, { estimatedTokens: 500, estimatedCostUsd: 0 })).allowed).toBe(true);
    const events = await listBudgetEvents(conn.db, owner, raised.id);
    expect(events[0]).toMatchObject({ actionTaken: 'limit_changed_halt_lifted', newBand: 'normal' });
    const resumed = await conn.db.select().from(systemEvents).where(eq(systemEvents.type, 'budget.resumed'));
    expect(resumed.length).toBe(1);
  });

  it('still halts when the checkpoint hook fails, and records that no checkpoint exists', async () => {
    const otherTask = uuidv7();
    const budget = await upsertBudget(conn.db, owner, { level: 'task', scopeRefId: otherTask, costLimitUsd: '1.00' });
    const r = await recordConsumption(
      conn.db,
      owner,
      { workspaceId, taskId: otherTask },
      { tokens: 10, costUsd: 0.97 },
      {
        onHalt: async () => {
          throw new Error('storage offline');
        },
      },
    );
    expect(r.transitions[0]).toMatchObject({ newBand: 'halt_95', haltTriggered: true, checkpointId: null });
    const events = await listBudgetEvents(conn.db, owner, budget.id);
    expect(events[0]!.actionTaken).toBe('halt_and_checkpoint:no_checkpoint');
  });

  it('keeps the budget event ledger append-only', async () => {
    const [ev] = await conn.db.select().from(budgetEvents).limit(1);
    await expect(
      conn.db.execute(sql`update budget_events set action_taken = 'tampered' where id = ${ev!.id}`),
    ).rejects.toThrow();
    await expect(conn.db.execute(sql`delete from budget_events where id = ${ev!.id}`)).rejects.toThrow();
  });
});
