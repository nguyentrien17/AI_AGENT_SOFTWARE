import { and, desc, eq, sql } from 'drizzle-orm';
import { approvals, type Db, toolExecutions } from '@platform/db';
import { audit, emitEvent } from '@platform/observability';
import { type Actor, hashJson } from '@platform/shared';

export const TOOL_CALL_APPROVAL = 'tool_call';

export type ToolApprovalState =
  | { state: 'approved'; approvalId: string }
  | { state: 'pending'; approvalId: string; created: boolean };

/**
 * Human approval for one high-risk tool call (Blueprint §16.3, P8-05). An approval covers exactly one
 * (task, tool, input) and can be used once. Repeated identical requests reuse the open request instead of
 * flooding reviewers. Decisions are made by humans in the approval manager, never here.
 */
export async function resolveToolApproval(
  db: Db,
  requester: Actor,
  input: { projectId: string; workspaceId: string; taskId: string; toolKey: string; toolInput: unknown; risk: string; reason: string },
): Promise<ToolApprovalState> {
  const inputHash = hashJson(input.toolInput ?? null);
  const matching = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.taskId, input.taskId),
        eq(approvals.kind, TOOL_CALL_APPROVAL),
        sql`${approvals.subject}->>'toolKey' = ${input.toolKey}`,
        sql`${approvals.subject}->>'inputHash' = ${inputHash}`,
      ),
    )
    .orderBy(desc(approvals.createdAt), desc(approvals.id));

  for (const a of matching.filter((x) => x.status === 'approved')) {
    const [used] = await db
      .select({ id: toolExecutions.id })
      .from(toolExecutions)
      .where(
        and(
          eq(toolExecutions.taskId, input.taskId),
          eq(toolExecutions.status, 'succeeded'),
          sql`${toolExecutions.decision}->>'approvalId' = ${a.id}`,
        ),
      )
      .limit(1);
    if (!used) return { state: 'approved', approvalId: a.id };
  }
  const open = matching.find((x) => x.status === 'pending');
  if (open) return { state: 'pending', approvalId: open.id, created: false };

  const [row] = await db
    .insert(approvals)
    .values({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      kind: TOOL_CALL_APPROVAL,
      taskId: input.taskId,
      title: `Allow ${input.risk}-risk tool '${input.toolKey}'`,
      subject: { toolKey: input.toolKey, inputHash, risk: input.risk, reason: input.reason },
      requestedByType: requester.type,
      requestedById: requester.type === 'agent' ? `${requester.agentKey}@${requester.agentVersion}` : 'tool-executor',
    })
    .returning();
  await audit(db, requester, {
    action: 'approval.requested',
    targetType: 'approval',
    targetId: row!.id,
    projectId: input.projectId,
    payload: { kind: TOOL_CALL_APPROVAL, toolKey: input.toolKey, taskId: input.taskId },
  });
  await emitEvent(db, {
    type: 'approval.requested',
    aggregateType: 'approval',
    aggregateId: row!.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    payload: { kind: TOOL_CALL_APPROVAL, toolKey: input.toolKey, taskId: input.taskId },
  });
  return { state: 'pending', approvalId: row!.id, created: true };
}
