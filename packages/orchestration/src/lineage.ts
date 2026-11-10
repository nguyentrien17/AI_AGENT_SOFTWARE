import { asc, eq, inArray } from 'drizzle-orm';
import {
  agentExecutions,
  agentHandoffs,
  agents,
  agentVersions,
  aiModels,
  aiProviders,
  approvals,
  contextPackages,
  costRecords,
  type Db,
  modelInvocations,
  qualityGateEvaluations,
  taskDependencies,
  taskExecutions,
  taskStatusHistory,
  tasks,
  tokenUsage,
  toolExecutions,
  users,
  workflowRuns,
  workflowSteps,
} from '@platform/db';
import { authorize } from '@platform/iam';
import type { Actor } from '@platform/shared';
import { getTaskWorkspaceDiff } from '@platform/tool-executor';
import { getTask } from './tasks.js';

/**
 * Full lineage of one task (Blueprint §17, P8-06). Each section answers one of the mandatory audit
 * questions, built only from append-only records.
 */
export async function getTaskLineage(db: Db, actor: Actor, taskId: string, opts: { storageRoot?: string } = {}) {
  const task = await getTask(db, actor, taskId); // authorizes task.read
  // Lineage exposes the audit trail (actors, prompts' provenance, approvals): auditors only.
  await authorize(db, actor, 'audit.read', { projectId: task.projectId });

  // 1. Why was this agent invoked? — objective, workflow stage, upstream work and the handoffs it received.
  const [step] = task.workflowStepId ? await db.select().from(workflowSteps).where(eq(workflowSteps.id, task.workflowStepId)) : [];
  const [run] = task.workflowRunId ? await db.select().from(workflowRuns).where(eq(workflowRuns.id, task.workflowRunId)) : [];
  const upstream = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(eq(taskDependencies.taskId, task.id));
  const received = upstream.length
    ? await db
        .select({ id: agentHandoffs.id, fromAgent: agentHandoffs.fromAgent, toAgent: agentHandoffs.toAgent, taskId: agentHandoffs.taskId, payloadHash: agentHandoffs.payloadHash })
        .from(agentHandoffs)
        .where(inArray(agentHandoffs.taskId, upstream.map((u) => u.id)))
    : [];

  // 2. Who or which policy scheduled it? — creator, run starter and every transition with its actor.
  const history = await db
    .select()
    .from(taskStatusHistory)
    .where(eq(taskStatusHistory.taskId, task.id))
    .orderBy(asc(taskStatusHistory.createdAt), asc(taskStatusHistory.id));

  // 3. Which model and parameters, and why? — every invocation with its routing rationale and cost.
  const invocations = await db
    .select({
      id: modelInvocations.id,
      status: modelInvocations.status,
      providerKey: aiProviders.providerKey,
      modelKey: aiModels.modelKey,
      configId: modelInvocations.configId,
      configVersion: modelInvocations.configVersion,
      agentKey: modelInvocations.agentKey,
      agentVersion: modelInvocations.agentVersion,
      retryCount: modelInvocations.retryCount,
      durationMs: modelInvocations.durationMs,
      routingExplanation: modelInvocations.routingExplanation,
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      estimatedCost: costRecords.estimatedCost,
      actualCost: costRecords.actualCost,
      createdAt: modelInvocations.createdAt,
    })
    .from(modelInvocations)
    .innerJoin(aiProviders, eq(aiProviders.id, modelInvocations.providerId))
    .innerJoin(aiModels, eq(aiModels.id, modelInvocations.modelId))
    .leftJoin(tokenUsage, eq(tokenUsage.invocationId, modelInvocations.id))
    .leftJoin(costRecords, eq(costRecords.invocationId, modelInvocations.id))
    .where(eq(modelInvocations.taskId, task.id))
    .orderBy(asc(modelInvocations.createdAt), asc(modelInvocations.id));

  // 4. Which exact versioned files were in the Context Package?
  const packages = await db.select().from(contextPackages).where(eq(contextPackages.taskId, task.id)).orderBy(asc(contextPackages.createdAt));
  const contextPackagesOut = packages.map((p) => ({
    id: p.id,
    manifestHash: p.manifestHash,
    estimatedTokens: p.estimatedTokens,
    invalidatedAt: p.invalidatedAt,
    items: ((p.manifest as { items?: Array<Record<string, unknown>> }).items ?? []).map((i) => ({
      path: i['path'],
      version: i['version'],
      sha256: i['hash'],
      source: i['source'],
    })),
  }));

  // 5. Which tools did the agent execute?
  const tools = await db
    .select({
      id: toolExecutions.id,
      toolKey: toolExecutions.toolKey,
      status: toolExecutions.status,
      input: toolExecutions.input,
      errorCode: toolExecutions.errorCode,
      exitCode: toolExecutions.exitCode,
      durationMs: toolExecutions.durationMs,
      decision: toolExecutions.decision,
      createdAt: toolExecutions.createdAt,
    })
    .from(toolExecutions)
    .where(eq(toolExecutions.taskId, task.id))
    .orderBy(asc(toolExecutions.createdAt), asc(toolExecutions.id));

  // 6. Which files were created or modified? — exact diff of the task branch plus versioned artifacts.
  const handoffs = await db.select().from(agentHandoffs).where(eq(agentHandoffs.taskId, task.id));
  const diff = opts.storageRoot ? await getTaskWorkspaceDiff(db, opts.storageRoot, task.id) : null;

  // 7. Which deterministic checks and Quality Gates ran, with what output?
  const gates = await db
    .select()
    .from(qualityGateEvaluations)
    .where(eq(qualityGateEvaluations.taskId, task.id))
    .orderBy(asc(qualityGateEvaluations.evaluatedAt), asc(qualityGateEvaluations.id));

  // 8. Which human approved?
  const approvalRows = await db
    .select({
      id: approvals.id,
      kind: approvals.kind,
      status: approvals.status,
      title: approvals.title,
      comment: approvals.comment,
      decidedAt: approvals.decidedAt,
      decidedByEmail: users.email,
      decidedByName: users.displayName,
    })
    .from(approvals)
    .leftJoin(users, eq(users.id, approvals.decidedBy))
    .where(eq(approvals.taskId, task.id))
    .orderBy(asc(approvals.createdAt));

  // Executions: which agent version ran each attempt, and how it ended.
  const executions = await db
    .select({
      id: taskExecutions.id,
      attemptNo: taskExecutions.attemptNo,
      workerId: taskExecutions.workerId,
      status: taskExecutions.status,
      startedAt: taskExecutions.startedAt,
      endedAt: taskExecutions.endedAt,
      failure: taskExecutions.failure,
      agentKey: agents.agentKey,
      agentVersion: agentVersions.versionNo,
      agentVersionHash: agentVersions.contentHash,
    })
    .from(taskExecutions)
    .leftJoin(agentVersions, eq(agentVersions.id, taskExecutions.agentVersionId))
    .leftJoin(agents, eq(agents.id, agentVersions.agentId))
    .where(eq(taskExecutions.taskId, task.id))
    .orderBy(asc(taskExecutions.attemptNo));
  const agentRuns = await db.select().from(agentExecutions).where(eq(agentExecutions.taskId, task.id)).orderBy(asc(agentExecutions.createdAt));

  return {
    task: { id: task.id, projectId: task.projectId, title: task.title, status: task.status, retryCount: task.retryCount },
    why: {
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      stage: step ? { key: step.stageKey, config: step.config } : null,
      workflowRun: run ? { id: run.id, status: run.status, variables: run.variables } : null,
      upstream,
      handoffsReceived: received,
    },
    scheduledBy: {
      createdBy: task.createdBy,
      runStartedBy: run ? { type: run.startedByType, id: run.startedById } : null,
      transitions: history.map((h) => ({ from: h.fromStatus, to: h.toStatus, reason: h.reason, actorType: h.actorType, actorId: h.actorId, at: h.createdAt })),
    },
    executions: executions.map((e) => ({
      ...e,
      agentRuns: agentRuns
        .filter((a) => a.taskExecutionId === e.id)
        .map((a) => ({ status: a.status, contextPackageId: a.contextPackageId, invocationIds: a.invocationIds, handoffId: a.handoffId, outputRepairs: a.outputRepairs })),
    })),
    modelInvocations: invocations,
    contextPackages: contextPackagesOut,
    toolCalls: tools.map(({ decision, ...t }) => ({ ...t, approvalId: (decision as { approvalId?: string }).approvalId ?? null })),
    changes: {
      workspace: diff ? { branch: diff.branch, baseBranch: diff.baseBranch, files: diff.files, diff: diff.diff, truncated: diff.truncated } : null,
      handoffs: handoffs.map((h) => ({ id: h.id, toAgent: h.toAgent, status: h.status, payloadHash: h.payloadHash, outputRefs: (h.payload as { output_refs?: unknown[] }).output_refs ?? [] })),
    },
    qualityGates: gates.map((g) => ({ gateKey: g.gateKey, outcome: g.outcome, evidence: g.evidence, evaluatedAt: g.evaluatedAt })),
    approvals: approvalRows,
  };
}
