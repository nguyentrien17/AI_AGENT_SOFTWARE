import { and, asc, desc, eq } from 'drizzle-orm';
import { createArtifactVersion, loadVersionContent, type ArtifactDeps } from '@platform/artifacts';
import { checkpoints, contextItems, contextVersions, type Db, projects, tasks } from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import { gitCommitAll, gitCreateBranchAt } from '@platform/projects';
import {
  type Actor,
  actorId,
  ConflictError,
  ForbiddenError,
  hashJson,
  NotFoundError,
  uuidv7,
  ValidationError,
} from '@platform/shared';

export interface CheckpointState {
  schema_version: '1.0';
  project_id: string;
  context_version: number;
  artifacts: Array<{
    item_id: string;
    path: string;
    current_version: number;
    current_sha256: string;
    approved_version: number | null;
    approved_sha256: string | null;
  }>;
  tasks: Array<{ id: string; status: string; version: number; retry_count: number }>;
  extra: Record<string, unknown>;
}

async function authorizeCheckpoint(db: Db, actor: Actor, projectId: string, mode: 'read' | 'write') {
  if (actor.type === 'system') return;
  if (actor.type === 'agent')
    throw new ForbiddenError('Checkpoints are created by the orchestrator or humans');
  await authorize(db, actor, mode === 'write' ? 'project.update' : 'project.read', { projectId });
}

/**
 * Captures an immutable, hashed snapshot of the project's context state (every artifact version + hash and every
 * task status) and commits the workspace to git, enabling pause/resume and crash recovery (Blueprint §7.1).
 */
export async function createCheckpoint(
  deps: ArtifactDeps,
  actor: Actor,
  projectId: string,
  input: {
    label: string;
    taskId?: string | null;
    workflowRunId?: string | null;
    extra?: Record<string, unknown>;
  },
) {
  await authorizeCheckpoint(deps.db, actor, projectId, 'write');
  const label = input.label.trim();
  if (!label || label.length > 200) throw new ValidationError('Checkpoint label must be 1-200 characters');
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new NotFoundError('Project', projectId);
  if (input.taskId) {
    const [t] = await deps.db.select({ p: tasks.projectId }).from(tasks).where(eq(tasks.id, input.taskId));
    if (!t || t.p !== projectId) throw new ValidationError('taskId does not belong to this project');
  }

  // Consistent snapshot of metadata in a single transaction.
  const state = await deps.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [p] = await tx
      .select({ cv: projects.contextVersion })
      .from(projects)
      .where(eq(projects.id, projectId));
    const items = await tx
      .select()
      .from(contextItems)
      .where(eq(contextItems.projectId, projectId))
      .orderBy(asc(contextItems.path));
    const versions = await tx
      .select({
        itemId: contextVersions.contextItemId,
        no: contextVersions.versionNo,
        sha: contextVersions.sha256,
      })
      .from(contextVersions)
      .innerJoin(contextItems, eq(contextItems.id, contextVersions.contextItemId))
      .where(eq(contextItems.projectId, projectId));
    const shaOf = (id: string, no: number | null) =>
      no === null ? null : (versions.find((v) => v.itemId === id && v.no === no)?.sha ?? null);
    const taskRows = await tx
      .select({ id: tasks.id, status: tasks.status, version: tasks.version, retryCount: tasks.retryCount })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(tasks.id));
    const s: CheckpointState = {
      schema_version: '1.0',
      project_id: projectId,
      context_version: p!.cv,
      artifacts: items.map((i) => ({
        item_id: i.id,
        path: i.path,
        current_version: i.currentVersionNo,
        current_sha256: shaOf(i.id, i.currentVersionNo)!,
        approved_version: i.approvedVersionNo,
        approved_sha256: shaOf(i.id, i.approvedVersionNo),
      })),
      tasks: taskRows.map((t) => ({
        id: t.id,
        status: t.status,
        version: t.version,
        retry_count: t.retryCount,
      })),
      extra: input.extra ?? {},
    };
    return s;
  });

  const id = uuidv7();
  const ps = deps.storage.scoped(project.storagePath);
  await ps.writeAtomic(
    `.ai-context/10-checkpoints/${id}.json`,
    JSON.stringify({ checkpoint_id: id, label, ...state }, null, 2) + '\n',
  );
  const gitCommit = await gitCommitAll(ps.root, `checkpoint: ${label} (${id})`);

  return deps.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(checkpoints)
      .values({
        id,
        projectId,
        taskId: input.taskId ?? null,
        workflowRunId: input.workflowRunId ?? null,
        label,
        contextVersion: state.context_version,
        state: state as unknown as Record<string, unknown>,
        stateHash: hashJson(state),
        gitCommit,
        createdByType: actor.type,
        createdById: actorId(actor),
      })
      .returning();
    await audit(tx, actor, {
      action: 'checkpoint.create',
      targetType: 'checkpoint',
      targetId: id,
      projectId,
      payload: { label, gitCommit },
    });
    await emitEvent(tx, {
      type: 'checkpoint.created',
      aggregateType: 'checkpoint',
      aggregateId: id,
      workspaceId: project.workspaceId,
      projectId,
    });
    return row!;
  });
}

export async function listCheckpoints(db: Db, actor: Actor, projectId: string) {
  await authorizeCheckpoint(db, actor, projectId, 'read');
  return db
    .select({
      id: checkpoints.id,
      label: checkpoints.label,
      taskId: checkpoints.taskId,
      contextVersion: checkpoints.contextVersion,
      stateHash: checkpoints.stateHash,
      gitCommit: checkpoints.gitCommit,
      createdAt: checkpoints.createdAt,
    })
    .from(checkpoints)
    .where(eq(checkpoints.projectId, projectId))
    .orderBy(desc(checkpoints.createdAt));
}

export interface CheckpointVerification {
  valid: boolean;
  problems: Array<{ path: string; problem: string }>;
}

/**
 * Verifies a checkpoint is restorable: state hash intact and every referenced artifact version still exists with
 * the same SHA-256 and readable, untampered content.
 */
export async function verifyCheckpoint(deps: ArtifactDeps, actor: Actor, checkpointId: string) {
  const [cp] = await deps.db.select().from(checkpoints).where(eq(checkpoints.id, checkpointId)).limit(1);
  if (!cp) throw new NotFoundError('Checkpoint', checkpointId);
  await authorizeCheckpoint(deps.db, actor, cp.projectId, 'read');
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, cp.projectId));
  const state = cp.state as unknown as CheckpointState;
  const problems: CheckpointVerification['problems'] = [];
  if (hashJson(state) !== cp.stateHash) problems.push({ path: '(state)', problem: 'state hash mismatch' });
  for (const a of state.artifacts) {
    const refs: Array<[number, string]> = [[a.current_version, a.current_sha256]];
    if (a.approved_version !== null && a.approved_sha256) refs.push([a.approved_version, a.approved_sha256]);
    for (const [no, sha] of refs) {
      const [v] = await deps.db
        .select()
        .from(contextVersions)
        .where(and(eq(contextVersions.contextItemId, a.item_id), eq(contextVersions.versionNo, no)))
        .limit(1);
      if (!v) {
        problems.push({ path: a.path, problem: `version ${no} missing` });
        continue;
      }
      if (v.sha256 !== sha) {
        problems.push({ path: a.path, problem: `version ${no} hash changed` });
        continue;
      }
      try {
        await loadVersionContent(deps.storage, project!, v);
      } catch {
        problems.push({ path: a.path, problem: `version ${no} content unreadable or tampered` });
      }
    }
  }
  return {
    checkpoint: cp,
    verification: { valid: problems.length === 0, problems } satisfies CheckpointVerification,
  };
}

export interface RestoreReport {
  checkpointId: string;
  /** Artifacts that got a new version carrying the checkpoint content. */
  restored: Array<{ path: string; checkpointVersion: number; previousVersion: number; newVersion: number }>;
  unchanged: number;
  /** Artifacts created after the checkpoint. History is never deleted: they are only reported. */
  addedSince: string[];
  /** Task status then vs now. Task states are not rewritten (they follow the task state machine). */
  taskDifferences: Array<{ id: string; then: string; now: string | null }>;
  /** Branch created at the checkpoint's git commit, if any. */
  gitBranch: string | null;
}

/**
 * Restores a project's context to a checkpoint (Phase 2 risk R9) without destroying history: every artifact
 * whose current version differs gets a new version with the checkpoint's content, the code at the
 * checkpoint is exposed on branch `restore/<checkpointId>`, and everything that cannot be reverted safely
 * (artifacts added later, task states) is reported for a human to decide. Humans only; the checkpoint must
 * verify first.
 */
export async function restoreCheckpoint(deps: ArtifactDeps, actor: Actor, checkpointId: string): Promise<RestoreReport> {
  if (actor.type !== 'user') throw new ForbiddenError('Only a human may restore a checkpoint');
  const [cp] = await deps.db.select().from(checkpoints).where(eq(checkpoints.id, checkpointId)).limit(1);
  if (!cp) throw new NotFoundError('Checkpoint', checkpointId);
  await authorizeCheckpoint(deps.db, actor, cp.projectId, 'write');
  const { verification } = await verifyCheckpoint(deps, actor, checkpointId);
  if (!verification.valid) {
    throw new ConflictError(
      `Checkpoint cannot be restored: ${verification.problems.map((p) => `${p.path} ${p.problem}`).join('; ')}`,
      'checkpoint_invalid',
    );
  }
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, cp.projectId)).limit(1);
  const state = cp.state as unknown as CheckpointState;
  const system: Actor = { type: 'system', workspaceId: project!.workspaceId, component: 'checkpoint-restore' };
  const report: RestoreReport = { checkpointId, restored: [], unchanged: 0, addedSince: [], taskDifferences: [], gitBranch: null };

  for (const a of state.artifacts) {
    const [item] = await deps.db.select().from(contextItems).where(eq(contextItems.id, a.item_id)).limit(1);
    if (!item) continue;
    // Compare content, not version numbers: after a restore the content matches under a newer version.
    const [current] = await deps.db
      .select({ sha256: contextVersions.sha256 })
      .from(contextVersions)
      .where(and(eq(contextVersions.contextItemId, item.id), eq(contextVersions.versionNo, item.currentVersionNo)))
      .limit(1);
    if (current?.sha256 === a.current_sha256) {
      report.unchanged++;
      continue;
    }
    const [v] = await deps.db
      .select()
      .from(contextVersions)
      .where(and(eq(contextVersions.contextItemId, a.item_id), eq(contextVersions.versionNo, a.current_version)))
      .limit(1);
    const content = await loadVersionContent(deps.storage, project!, v!);
    const { version } = await createArtifactVersion(deps, system, item.id, {
      content,
      expectedVersionNo: item.currentVersionNo,
      changeNote: `restored from checkpoint ${checkpointId} (v${a.current_version})`,
    });
    report.restored.push({ path: a.path, checkpointVersion: a.current_version, previousVersion: item.currentVersionNo, newVersion: version.versionNo });
  }

  const known = new Set(state.artifacts.map((a) => a.item_id));
  const items = await deps.db.select({ id: contextItems.id, path: contextItems.path }).from(contextItems).where(eq(contextItems.projectId, cp.projectId));
  report.addedSince = items.filter((i) => !known.has(i.id)).map((i) => i.path).sort();

  const nowTasks = new Map(
    (await deps.db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(eq(tasks.projectId, cp.projectId))).map((t) => [t.id, t.status]),
  );
  for (const t of state.tasks) {
    const now = nowTasks.get(t.id) ?? null;
    if (now !== t.status) report.taskDifferences.push({ id: t.id, then: t.status, now });
  }

  if (cp.gitCommit) {
    const branch = `restore/${checkpointId}`;
    const repoDir = deps.storage.scoped(project!.storagePath).root;
    await gitCreateBranchAt(repoDir, branch, cp.gitCommit);
    report.gitBranch = branch;
  }

  await audit(deps.db, actor, {
    action: 'checkpoint.restore',
    targetType: 'checkpoint',
    targetId: checkpointId,
    projectId: cp.projectId,
    payload: { restored: report.restored.length, addedSince: report.addedSince.length, gitBranch: report.gitBranch },
  });
  await emitEvent(deps.db, {
    type: 'checkpoint.restored',
    aggregateType: 'checkpoint',
    aggregateId: checkpointId,
    workspaceId: project!.workspaceId,
    projectId: cp.projectId,
    payload: { restored: report.restored.map((r) => r.path), gitBranch: report.gitBranch },
  });
  return report;
}
