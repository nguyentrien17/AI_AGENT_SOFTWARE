import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  findArtifactByPath,
  normalizeArtifactPath,
  requireAgentTaskBinding,
  createArtifact,
  type ArtifactDeps,
} from '@platform/artifacts';
import { agentHandoffs, contextVersions, type Db, projects, tasks } from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import {
  type Actor,
  canonicalJson,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  sha256Hex,
  ValidationError,
} from '@platform/shared';

const RoleKey = Type.String({ pattern: '^[a-z][a-z0-9_]{1,39}$' });
const ShortText = Type.String({ minLength: 1, maxLength: 2000 });

/** Blueprint §6.4 structured handoff, schema_version 1.0. Unknown properties are rejected. */
export const HandoffSchema = Type.Object(
  {
    schema_version: Type.Literal('1.0'),
    handoff_id: Type.String({ format: 'uuid' }),
    project_id: Type.String({ format: 'uuid' }),
    task_id: Type.String({ format: 'uuid' }),
    from_agent: RoleKey,
    to_agent: RoleKey,
    status: Type.Union([
      Type.Literal('completed'),
      Type.Literal('partial'),
      Type.Literal('blocked'),
      Type.Literal('failed'),
    ]),
    output_refs: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1, maxLength: 500 }),
          version: Type.Integer({ minimum: 1 }),
          sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 200 },
    ),
    decisions: Type.Array(ShortText, { maxItems: 100 }),
    assumptions: Type.Array(ShortText, { maxItems: 100 }),
    open_questions: Type.Array(ShortText, { maxItems: 100 }),
    required_actions: Type.Array(ShortText, { maxItems: 100 }),
    created_at: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type Handoff = Static<typeof HandoffSchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Pure structural validation. Returns a list of errors (empty = valid). */
export function validateHandoffShape(payload: unknown): Array<{ path: string; message: string }> {
  const errors = [...Value.Errors(HandoffSchema, payload)]
    // TypeBox does not ship format validators; formats are checked explicitly below.
    .filter((e) => !String(e.message).toLowerCase().includes('format'))
    .map((e) => ({ path: e.path || '/', message: e.message }));
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    for (const k of ['handoff_id', 'project_id', 'task_id']) {
      if (typeof p[k] === 'string' && !UUID_RE.test(p[k] as string))
        errors.push({ path: `/${k}`, message: 'must be a uuid' });
    }
    if (
      typeof p.created_at === 'string' &&
      (!ISO_RE.test(p.created_at) || Number.isNaN(Date.parse(p.created_at)))
    ) {
      errors.push({ path: '/created_at', message: 'must be an ISO 8601 date-time' });
    }
  }
  return errors;
}

export function handoffArtifactPath(h: Pick<Handoff, 'from_agent' | 'task_id' | 'handoff_id'>): string {
  return `.ai-context/05-agent-handoffs/${h.from_agent}/${h.task_id}/${h.handoff_id}.json`;
}

/**
 * Validates and persists a handoff. Every `output_ref` must resolve to a persisted artifact version in the same
 * project whose SHA-256 matches. The handoff itself is stored as an immutable artifact plus a DB row.
 * Handoff content is data only: it cannot change permissions, routing or policies.
 */
export async function submitHandoff(deps: ArtifactDeps, actor: Actor, payload: unknown) {
  const shapeErrors = validateHandoffShape(payload);
  if (shapeErrors.length) throw new ValidationError('Invalid handoff payload', shapeErrors);
  const h = payload as Handoff;

  const [task] = await deps.db.select().from(tasks).where(eq(tasks.id, h.task_id)).limit(1);
  if (!task) throw new NotFoundError('Task', h.task_id);
  if (task.projectId !== h.project_id) throw new ValidationError('task_id does not belong to project_id');

  if (actor.type === 'agent') {
    if (actor.agentKey !== h.from_agent)
      throw new ForbiddenError('from_agent must match the submitting agent');
    if (actor.taskId !== h.task_id) throw new ForbiddenError('Agents may only hand off their own task');
    await requireAgentTaskBinding(deps.db, actor, h.project_id, 'write');
  } else if (actor.type === 'user') {
    throw new ForbiddenError('Handoffs are emitted by agents or the orchestrator, not by humans');
  }

  const [dup] = await deps.db
    .select({ id: agentHandoffs.id })
    .from(agentHandoffs)
    .where(eq(agentHandoffs.id, h.handoff_id));
  if (dup) throw new ConflictError(`Handoff '${h.handoff_id}' already exists`, 'handoff_exists');

  const refErrors: Array<{ path: string; message: string }> = [];
  const seen = new Set<string>();
  for (const [i, ref] of h.output_refs.entries()) {
    let path: string;
    try {
      path = normalizeArtifactPath(ref.path);
    } catch {
      refErrors.push({ path: `/output_refs/${i}/path`, message: 'invalid artifact path' });
      continue;
    }
    if (seen.has(`${path}@${ref.version}`))
      refErrors.push({ path: `/output_refs/${i}`, message: 'duplicate reference' });
    seen.add(`${path}@${ref.version}`);
    const item = await findArtifactByPath(deps.db, h.project_id, path);
    if (!item) {
      refErrors.push({ path: `/output_refs/${i}/path`, message: `artifact '${path}' is not persisted` });
      continue;
    }
    const [v] = await deps.db
      .select({ sha256: contextVersions.sha256 })
      .from(contextVersions)
      .where(and(eq(contextVersions.contextItemId, item.id), eq(contextVersions.versionNo, ref.version)));
    if (!v)
      refErrors.push({ path: `/output_refs/${i}/version`, message: `version ${ref.version} does not exist` });
    else if (v.sha256 !== ref.sha256)
      refErrors.push({ path: `/output_refs/${i}/sha256`, message: 'hash mismatch' });
  }
  if (refErrors.length)
    throw new ValidationError('Handoff output_refs do not match persisted artifacts', refErrors);

  const canonical = canonicalJson(h);
  const { item } = await createArtifact(deps, actor, h.project_id, {
    path: handoffArtifactPath(h),
    type: 'handoff',
    content: JSON.stringify(JSON.parse(canonical), null, 2) + '\n',
    ownerRole: h.from_agent,
    changeNote: `handoff ${h.from_agent} → ${h.to_agent}`,
  });

  return deps.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(agentHandoffs)
      .values({
        id: h.handoff_id,
        projectId: h.project_id,
        taskId: h.task_id,
        fromAgent: h.from_agent,
        toAgent: h.to_agent,
        status: h.status,
        payload: h as unknown as Record<string, unknown>,
        payloadHash: sha256Hex(canonical),
        artifactItemId: item.id,
      })
      .returning();
    const [p] = await tx
      .select({ ws: projects.workspaceId })
      .from(projects)
      .where(eq(projects.id, h.project_id));
    await audit(tx, actor, {
      action: 'handoff.create',
      targetType: 'handoff',
      targetId: h.handoff_id,
      projectId: h.project_id,
      payload: { from: h.from_agent, to: h.to_agent, status: h.status, refs: h.output_refs.length },
    });
    await emitEvent(tx, {
      type: 'handoff.created',
      aggregateType: 'handoff',
      aggregateId: h.handoff_id,
      workspaceId: p!.ws,
      projectId: h.project_id,
      payload: { task_id: h.task_id, from_agent: h.from_agent, to_agent: h.to_agent, status: h.status },
    });
    return row!;
  });
}

/** Latest usable handoff per task (status completed or partial). Internal, no authorization. */
export async function latestHandoffsForTasks(db: Db, taskIds: string[]) {
  if (!taskIds.length) return [];
  const rows = await db
    .select()
    .from(agentHandoffs)
    .where(
      and(inArray(agentHandoffs.taskId, taskIds), inArray(agentHandoffs.status, ['completed', 'partial'])),
    )
    .orderBy(desc(agentHandoffs.createdAt), desc(agentHandoffs.id));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.taskId)) latest.set(r.taskId, r);
  return [...latest.values()];
}

export async function listHandoffs(db: Db, actor: Actor, projectId: string, opts: { taskId?: string } = {}) {
  await authorize(db, actor, 'artifact.read', { projectId });
  const conds = [eq(agentHandoffs.projectId, projectId)];
  if (opts.taskId) conds.push(eq(agentHandoffs.taskId, opts.taskId));
  return db
    .select()
    .from(agentHandoffs)
    .where(and(...conds))
    .orderBy(desc(agentHandoffs.createdAt));
}

export async function getHandoff(db: Db, actor: Actor, handoffId: string) {
  const [h] = await db.select().from(agentHandoffs).where(eq(agentHandoffs.id, handoffId)).limit(1);
  if (!h) throw new NotFoundError('Handoff', handoffId);
  await authorize(db, actor, 'artifact.read', { projectId: h.projectId });
  return h;
}
