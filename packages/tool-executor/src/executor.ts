import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  agents,
  agentVersions,
  type Db,
  projects,
  repositories,
  taskAssignments,
  taskLeases,
  tasks,
  toolExecutions,
  toolPermissions,
} from '@platform/db';
import { audit } from '@platform/observability';
import { type Actor, actorId, AppError, isAppError, redact, sha256Hex } from '@platform/shared';
import { resolveToolApproval } from './approvals.js';
import type { ToolCatalog } from './catalog.js';
import { DestructiveGitError, ensureTaskWorktree, gitDiffAgainstBase } from './git.js';
import { normalizeToolPath, PathJailError, WorkspaceJail } from './jail.js';
import { evaluateToolPermission, type PermissionDecision } from './permissions.js';
import type { AnyToolDefinition, ToolContext, ToolRisk } from './types.js';

export interface ToolExecutorDeps {
  db: Db;
  /** Absolute storage root; project repositories and task worktrees live under it. */
  storageRoot: string;
  catalog: ToolCatalog;
  now?: () => Date;
}

export interface ToolCall {
  toolKey: string;
  input: unknown;
  /** The task execution (attempt) making the call; when given it must hold the task lease. */
  taskExecutionId?: string | null;
}

export type ToolCallStatus = 'succeeded' | 'failed' | 'denied' | 'approval_required' | 'timed_out';

export interface ToolCallOutcome {
  toolExecutionId: string;
  toolKey: string;
  status: ToolCallStatus;
  output: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  decision: PermissionDecision | null;
  /** The approval request this call is waiting for, or the approval that authorized it. */
  approvalId: string | null;
}

/** The sandbox runtime is not available on this host (Phase 6 part B; ADR-009: no host fallback). */
export class SandboxUnavailableError extends AppError {
  constructor(toolKey: string) {
    super({
      status: 503,
      code: 'sandbox_unavailable',
      title: 'Sandbox unavailable',
      detail: `Tool '${toolKey}' runs untrusted code and needs an isolated sandbox, which is not configured`,
    });
  }
}

class ToolTimeoutError extends AppError {
  constructor(toolKey: string, seconds: number) {
    super({ status: 504, code: 'tool_timeout', title: 'Tool timed out', detail: `Tool '${toolKey}' exceeded ${seconds}s` });
  }
}

const validators = new WeakMap<object, ValidateFunction>();
function validatorFor(tool: AnyToolDefinition): ValidateFunction {
  let v = validators.get(tool.inputSchema);
  if (!v) {
    v = new Ajv({ strict: false, allErrors: true }).compile(tool.inputSchema);
    validators.set(tool.inputSchema, v);
  }
  return v;
}

/** Applies the tool's redaction policy plus global secret redaction before anything is stored. */
function redactInput(tool: AnyToolDefinition | undefined, input: unknown): Record<string, unknown> {
  const obj: Record<string, unknown> =
    typeof input === 'object' && input !== null && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : { value: input };
  for (const field of tool?.redaction.omitInputFields ?? []) {
    const v = obj[field];
    if (typeof v === 'string') obj[field] = { omitted: true, sizeBytes: Buffer.byteLength(v), sha256: sha256Hex(v) };
  }
  return redact(obj) as Record<string, unknown>;
}

function redactOutput(tool: AnyToolDefinition, output: Record<string, unknown>): Record<string, unknown> {
  if (!tool.redaction.summarizeOutput) return redact(output) as Record<string, unknown>;
  const json = JSON.stringify(output);
  const summary: Record<string, unknown> = { summarized: true, sizeBytes: Buffer.byteLength(json), sha256: sha256Hex(json) };
  for (const k of ['path', 'truncated', 'binary', 'files', 'sizeBytes']) if (k in output) summary[k] = output[k];
  return redact(summary) as Record<string, unknown>;
}

export function taskWorktreeDir(storageRoot: string, workspaceId: string, projectKey: string, taskId: string): string {
  return path.join(storageRoot, 'worktrees', workspaceId, projectKey, taskId);
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]);
}

/**
 * The only path from an agent to the file system or git (Blueprint §11.2). Validates input, evaluates the
 * 7-dimension permission check, confines paths to the task worktree, enforces the timeout, and records
 * every call — allowed or not — in the append-only `tool_executions` log. Never throws for an agent's
 * mistake: the outcome is returned so the agent can see why.
 */
export async function executeTool(deps: ToolExecutorDeps, actor: Actor, call: ToolCall): Promise<ToolCallOutcome> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  if (actor.type !== 'agent' || !actor.taskId) {
    throw new AppError({ status: 403, code: 'forbidden', title: 'Forbidden', detail: 'Tools are executed by agents bound to a task' });
  }
  const [task] = await db.select().from(tasks).where(eq(tasks.id, actor.taskId)).limit(1);
  if (!task) throw new AppError({ status: 404, code: 'not_found', title: 'Not found', detail: `Task '${actor.taskId}' not found` });
  const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1);
  const tool = deps.catalog.get(call.toolKey);

  const record = async (
    status: ToolCallStatus,
    decision: PermissionDecision | null,
    rest: { output?: Record<string, unknown>; error?: { code: string; message: string }; approvalId?: string } = {},
  ): Promise<ToolCallOutcome> => {
    const [row] = await db
      .insert(toolExecutions)
      .values({
        projectId: task.projectId,
        taskId: task.id,
        taskExecutionId: call.taskExecutionId ?? null,
        toolKey: call.toolKey.slice(0, 100),
        actorId: actorId(actor),
        input: redactInput(tool, call.input),
        status,
        decision: decision ? (decision as unknown as Record<string, unknown>) : {},
        output: rest.output && tool ? redactOutput(tool, rest.output) : null,
        errorCode: rest.error?.code ?? null,
        errorMessage: rest.error ? String(redact(rest.error.message)).slice(0, 2000) : null,
        durationMs: Math.max(0, Date.now() - started),
      })
      .returning();
    if (status === 'denied' || status === 'approval_required') {
      await audit(db, actor, {
        action: status === 'denied' ? 'tool.denied' : 'tool.approval_required',
        targetType: 'tool_execution',
        targetId: row!.id,
        projectId: task.projectId,
        payload: { toolKey: call.toolKey, reason: decision?.reason ?? rest.error?.message ?? null },
      });
    }
    return {
      toolExecutionId: row!.id,
      toolKey: call.toolKey,
      status,
      output: rest.output ?? null,
      error: rest.error ?? null,
      decision,
      approvalId: rest.approvalId ?? decision?.approvalId ?? null,
    };
  };
  const deny = (code: string, message: string, decision: PermissionDecision | null = null) =>
    record('denied', decision, { error: { code, message } });

  // ---- input validation (before any permission detail is revealed to a malformed call)
  if (!tool) return deny('unknown_tool', `Tool '${call.toolKey}' is not registered`);
  const validate = validatorFor(tool);
  if (!validate(call.input)) {
    const msg = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    return deny('invalid_input', `Invalid input for '${tool.toolKey}': ${msg}`);
  }
  const input = call.input as Record<string, unknown>;
  const paths: Array<{ path: string; access: 'read' | 'write' }> = [];
  try {
    for (const f of tool.pathFields) {
      const v = input[f.field];
      if (typeof v === 'string') paths.push({ path: normalizeToolPath(v), access: f.access });
    }
  } catch (err) {
    return deny('path_rejected', err instanceof Error ? err.message : String(err));
  }

  // ---- facts for the 7 dimensions
  const [assignment] = await db
    .select({ agent: agents, version: agentVersions })
    .from(taskAssignments)
    .innerJoin(agents, eq(agents.id, taskAssignments.agentId))
    .innerJoin(agentVersions, eq(agentVersions.id, taskAssignments.agentVersionId))
    .where(eq(taskAssignments.taskId, task.id))
    .orderBy(desc(taskAssignments.assignedAt), desc(taskAssignments.id))
    .limit(1);
  const [lease] = await db.select().from(taskLeases).where(eq(taskLeases.taskId, task.id)).limit(1);
  const leaseHeld =
    !!lease && lease.expiresAt > now && (!call.taskExecutionId || lease.executionId === call.taskExecutionId);
  const sameAgent =
    !!assignment && assignment.agent.role === actor.agentKey && assignment.version.versionNo === actor.agentVersion;
  const overrides = assignment
    ? await db
        .select()
        .from(toolPermissions)
        .where(
          and(
            eq(toolPermissions.workspaceId, assignment.agent.workspaceId),
            eq(toolPermissions.toolKey, tool.toolKey),
            inArray(toolPermissions.subjectId, [assignment.version.id, assignment.agent.role]),
          ),
        )
    : [];
  // An agent-version row is more specific than a role row.
  const override = overrides.find((o) => o.subjectType === 'agent_version') ?? overrides.find((o) => o.subjectType === 'role') ?? null;

  const decision = evaluateToolPermission({
    project: {
      ok: !!project && project.workspaceId === actor.workspaceId && project.status !== 'archived',
      detail: !project ? 'project not found' : project.workspaceId !== actor.workspaceId ? 'other workspace' : project.status === 'archived' ? 'project archived' : 'project active',
    },
    agent: {
      status: sameAgent ? assignment!.agent.status : null,
      allowedTools: sameAgent ? assignment!.version.allowedTools : [],
      allowedActions: sameAgent ? assignment!.version.allowedActions : [],
      allowedFileScopes: sameAgent ? assignment!.version.allowedFileScopes : [],
    },
    task: { status: task.status, leaseHeld, allowedTools: task.allowedTools },
    tool: { toolKey: tool.toolKey, action: tool.action, risk: tool.risk, registered: true },
    paths,
    override: override ? { fileScopes: override.fileScopes, maxRisk: override.maxRisk as ToolRisk } : null,
  });
  if (decision.verdict === 'deny') return deny('permission_denied', decision.reason ?? 'denied', decision);
  if (decision.verdict === 'require_approval') {
    const approval = await resolveToolApproval(db, actor, {
      projectId: task.projectId,
      workspaceId: project!.workspaceId,
      taskId: task.id,
      toolKey: tool.toolKey,
      toolInput: call.input,
      risk: tool.risk,
      reason: decision.reason ?? 'high-risk tool',
    });
    if (approval.state === 'pending') {
      return record('approval_required', decision, {
        error: {
          code: 'approval_required',
          message: `${decision.reason ?? 'human approval required'} (approval ${approval.approvalId})`,
        },
        approvalId: approval.approvalId,
      });
    }
    decision.approvalId = approval.approvalId; // approved by a human: usable exactly once
  }
  if (tool.requiresSandbox) {
    const err = new SandboxUnavailableError(tool.toolKey);
    return record('failed', decision, { error: { code: err.code, message: err.message } });
  }

  // ---- workspace: an isolated git worktree on branch task/{taskId}
  const [repo] = await db.select().from(repositories).where(eq(repositories.projectId, task.projectId)).limit(1);
  const repoDir = path.join(deps.storageRoot, project!.storagePath);
  const worktreeDir = taskWorktreeDir(deps.storageRoot, project!.workspaceId, project!.key, task.id);
  const baseBranch = repo?.defaultBranch ?? 'main';
  const ctx: ToolContext = {
    jail: new WorkspaceJail(worktreeDir),
    worktreeDir,
    baseBranch,
    taskId: task.id,
    fileScopes: override?.fileScopes.length ? override.fileScopes : assignment!.version.allowedFileScopes,
  };

  try {
    await ensureTaskWorktree({ repoDir, worktreeDir, taskId: task.id, baseBranch });
    const output = await withTimeout(
      tool.handler(ctx, input),
      tool.timeoutSeconds * 1000,
      () => new ToolTimeoutError(tool.toolKey, tool.timeoutSeconds),
    );
    return record('succeeded', decision, { output: output as Record<string, unknown> });
  } catch (err) {
    if (err instanceof PathJailError || err instanceof DestructiveGitError) {
      return deny(err instanceof PathJailError ? 'path_rejected' : 'destructive_git', err.message, decision);
    }
    if (err instanceof ToolTimeoutError) return record('timed_out', decision, { error: { code: err.code, message: err.message } });
    if (isAppError(err)) return record('failed', decision, { error: { code: err.code, message: err.message } });
    return record('failed', decision, { error: { code: 'tool_error', message: err instanceof Error ? err.message : String(err) } });
  }
}

export async function listToolExecutions(db: Db, taskId: string) {
  return db.select().from(toolExecutions).where(eq(toolExecutions.taskId, taskId)).orderBy(toolExecutions.createdAt, toolExecutions.id);
}

/** Unified diff of a task's worktree against its base branch, or null when the task never used a workspace. */
export async function getTaskWorkspaceDiff(db: Db, storageRoot: string, taskId: string) {
  const [row] = await db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row) return null;
  const [repo] = await db.select().from(repositories).where(eq(repositories.projectId, row.project.id)).limit(1);
  const worktreeDir = taskWorktreeDir(storageRoot, row.project.workspaceId, row.project.key, taskId);
  const present = await fsp.access(path.join(worktreeDir, '.git')).then(
    () => true,
    () => false,
  );
  if (!present) return null;
  const baseBranch = repo?.defaultBranch ?? 'main';
  return { branch: `task/${taskId}`, baseBranch, ...(await gitDiffAgainstBase(worktreeDir, baseBranch)) };
}
