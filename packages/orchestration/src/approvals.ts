import { and, desc, eq } from 'drizzle-orm';
import { approvals, type Db, projects, tasks } from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import { type Actor, actorId, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@platform/shared';
import { TOOL_CALL_APPROVAL } from '@platform/tool-executor';
import { recordGateEvaluation, transitionTask } from './tasks.js';
import { syncWorkflowStep } from './workflows.js';

export type Approval = typeof approvals.$inferSelect;
export const HUMAN_APPROVAL_GATE = 'human_approval';

const APPROVAL_MANAGER = (workspaceId: string): Actor => ({
  type: 'system',
  workspaceId,
  component: 'approval-manager',
});

const GATE_EVIDENCE = (approvalId: string) => ({
  tool: 'approval-manager',
  toolVersion: '1',
  command: 'human-decision',
  environmentId: approvalId,
  gitTreeHash: null,
  logUri: null,
});

/** Opens an approval request. Called by the platform only; humans decide, nobody else. */
export async function requestApproval(
  db: Db,
  requester: Actor,
  input: {
    projectId: string;
    kind: string;
    title: string;
    subject?: Record<string, unknown>;
    runId?: string | null;
    stepId?: string | null;
    taskId?: string | null;
  },
): Promise<Approval> {
  if (requester.type !== 'system') throw new ForbiddenError('Approval requests are opened by the platform');
  const [project] = await db.select({ ws: projects.workspaceId }).from(projects).where(eq(projects.id, input.projectId));
  if (!project) throw new NotFoundError('Project', input.projectId);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(approvals)
      .values({
        workspaceId: project.ws,
        projectId: input.projectId,
        kind: input.kind,
        title: input.title,
        subject: input.subject ?? {},
        runId: input.runId ?? null,
        stepId: input.stepId ?? null,
        taskId: input.taskId ?? null,
        requestedByType: requester.type,
        requestedById: actorId(requester),
      })
      .returning();
    await audit(tx, requester, {
      action: 'approval.requested',
      targetType: 'approval',
      targetId: row!.id,
      projectId: input.projectId,
      payload: { kind: input.kind, taskId: input.taskId ?? null },
    });
    await emitEvent(tx, {
      type: 'approval.requested',
      aggregateType: 'approval',
      aggregateId: row!.id,
      workspaceId: project.ws,
      projectId: input.projectId,
      payload: { kind: input.kind, title: input.title, taskId: input.taskId ?? null },
    });
    return row!;
  });
}

export async function listApprovals(
  db: Db,
  actor: Actor,
  projectId: string,
  filter: { status?: Approval['status'] } = {},
): Promise<Approval[]> {
  await authorize(db, actor, 'task.read', { projectId });
  return db
    .select()
    .from(approvals)
    .where(and(eq(approvals.projectId, projectId), filter.status ? eq(approvals.status, filter.status) : undefined))
    .orderBy(desc(approvals.createdAt), desc(approvals.id));
}

/** The most recent rejection comment for a task, fed back to the agent on its next attempt. */
export async function latestRejectionComment(db: Db, taskId: string): Promise<string | null> {
  const [row] = await db
    .select({ comment: approvals.comment })
    .from(approvals)
    .where(and(eq(approvals.taskId, taskId), eq(approvals.status, 'rejected')))
    .orderBy(desc(approvals.decidedAt), desc(approvals.id))
    .limit(1);
  return row?.comment ?? null;
}

/**
 * Records a human decision (Blueprint §16.3). Only a human holding `artifact.approve` on the project may
 * decide; agents and system components are rejected, so nothing can approve its own work.
 *
 * For a workflow gate: approval completes the task; rejection sends it back for rework with the comment
 * as feedback, within the task's bounded retries.
 */
export async function decideApproval(
  db: Db,
  actor: Actor,
  approvalId: string,
  input: { decision: 'approved' | 'rejected'; comment?: string },
): Promise<Approval> {
  if (actor.type !== 'user') throw new ForbiddenError('Only a human may decide an approval request');
  const [pending] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
  if (!pending) throw new NotFoundError('Approval', approvalId);
  await authorize(db, actor, 'artifact.approve', { projectId: pending.projectId });
  const comment = input.comment?.trim() ?? '';
  if (input.decision === 'rejected' && !comment) {
    throw new ValidationError('A rejection needs a comment explaining what must change');
  }

  const decided = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .update(approvals)
      .set({ status: input.decision, decidedBy: actor.userId, decidedAt: new Date(), comment: comment || null })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')))
      .returning();
    if (!row) throw new ConflictError(`Approval is already ${pending.status}`, 'approval_decided');
    await audit(tx, actor, {
      action: `approval.${input.decision}`,
      targetType: 'approval',
      targetId: approvalId,
      projectId: row.projectId,
      payload: { kind: row.kind, taskId: row.taskId, comment: comment || null },
    });
    await emitEvent(tx, {
      type: `approval.${input.decision}`,
      aggregateType: 'approval',
      aggregateId: approvalId,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      payload: { kind: row.kind, taskId: row.taskId },
    });
    return row;
  });

  if (decided.kind === TOOL_CALL_APPROVAL && decided.taskId) {
    // Either way the agent gets another turn: with the approval it can run the call once; after a
    // rejection the comment is its feedback (latestRejectionComment).
    const [parked] = await db.select().from(tasks).where(eq(tasks.id, decided.taskId)).limit(1);
    if (parked?.status === 'waiting_for_input') {
      await transitionTask(db, APPROVAL_MANAGER(decided.workspaceId), parked.id, 'ready', {
        reason: `tool call ${input.decision} by ${actor.userId}`,
      });
      await syncWorkflowStep(db, parked, 'pending');
    }
    return decided;
  }
  if (decided.kind !== 'workflow_gate' || !decided.taskId) return decided;
  const system = APPROVAL_MANAGER(decided.workspaceId);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, decided.taskId)).limit(1);
  if (!task || task.status !== 'waiting_for_approval') return decided;

  if (input.decision === 'approved') {
    await recordGateEvaluation(db, system, task.id, {
      gateKey: HUMAN_APPROVAL_GATE,
      outcome: 'passed',
      evidence: GATE_EVIDENCE(decided.id),
    });
    await transitionTask(db, system, task.id, 'completed', { reason: `approved by ${actor.userId}` });
    await syncWorkflowStep(db, task, 'completed', 'approved');
    return decided;
  }

  await recordGateEvaluation(db, system, task.id, {
    gateKey: HUMAN_APPROVAL_GATE,
    outcome: 'failed',
    evidence: GATE_EVIDENCE(decided.id),
  });
  await transitionTask(db, system, task.id, 'failed', { reason: `rejected: ${comment}` });
  if (task.retryCount < task.maxRetries) {
    // `failed → ready` increments the retry counter: rework loops are bounded like any other retry.
    await transitionTask(db, system, task.id, 'ready', { reason: 'rework requested by reviewer' });
    await syncWorkflowStep(db, task, 'pending', 'rejected');
  } else {
    await syncWorkflowStep(db, task, 'failed', 'rejected');
  }
  return decided;
}
