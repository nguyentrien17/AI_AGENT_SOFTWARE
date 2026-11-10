import { and, desc, eq } from 'drizzle-orm';
import { isAgentRole } from '@platform/artifacts';
import { type AgentRetryPolicy, agents, agentVersions, type Db } from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import {
  type Actor,
  actorId,
  ConflictError,
  ForbiddenError,
  hashJson,
  NotFoundError,
  ValidationError,
} from '@platform/shared';
import { jsonSchemaError } from './output.js';

export type Agent = typeof agents.$inferSelect;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type AgentStatus = 'active' | 'disabled' | 'deprecated';

/** The versioned part of an agent definition (Blueprint §6.1). An agent never names a model here. */
export interface AgentDefinition {
  systemInstruction: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  allowedTools?: string[];
  allowedFileScopes?: string[];
  allowedActions?: string[];
  modelConfigRef?: string | null;
  timeoutSeconds?: number;
  retryPolicy?: AgentRetryPolicy;
  completionCriteria?: string[];
}

export interface AgentView extends Agent {
  currentVersion: AgentVersion | null;
}

const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_OUTPUT_REPAIRS = 3;

function workspaceOf(actor: Actor): string {
  if (!actor.workspaceId) throw new ValidationError('A workspace context is required');
  return actor.workspaceId;
}

async function requireAdmin(db: Db, actor: Actor): Promise<void> {
  const { role } = await authorize(db, actor, 'ai.config.manage');
  if (role !== 'owner' && role !== 'administrator' && role !== 'system') {
    throw new ForbiddenError('Agent definitions can only be changed by workspace administrators');
  }
}

interface NormalizedDefinition {
  systemInstruction: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  allowedTools: string[];
  allowedFileScopes: string[];
  allowedActions: string[];
  modelConfigRef: string | null;
  timeoutSeconds: number;
  retryPolicy: AgentRetryPolicy;
  completionCriteria: string[];
}

function cleanList(values: string[] | undefined, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || !v.trim())) {
    throw new ValidationError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(values.map((v) => v.trim()))].sort();
}

export function normalizeDefinition(def: AgentDefinition): NormalizedDefinition {
  const systemInstruction = def.systemInstruction?.trim();
  if (!systemInstruction) throw new ValidationError('systemInstruction is required');
  const inputSchema = def.inputSchema ?? {};
  const outputSchema = def.outputSchema ?? {};
  for (const [name, schema] of [
    ['inputSchema', inputSchema],
    ['outputSchema', outputSchema],
  ] as const) {
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      throw new ValidationError(`${name} must be a JSON Schema object`);
    }
    const err = jsonSchemaError(schema);
    if (err) throw new ValidationError(`${name} is not a valid JSON Schema: ${err}`);
  }
  const timeoutSeconds = def.timeoutSeconds ?? 600;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
    throw new ValidationError('timeoutSeconds must be 1..86400');
  }
  const repairs = def.retryPolicy?.maxOutputRepairs ?? 1;
  if (!Number.isInteger(repairs) || repairs < 0 || repairs > MAX_OUTPUT_REPAIRS) {
    throw new ValidationError(`retryPolicy.maxOutputRepairs must be 0..${MAX_OUTPUT_REPAIRS} (bounded self-correction)`);
  }
  return {
    systemInstruction,
    inputSchema,
    outputSchema,
    allowedTools: cleanList(def.allowedTools, 'allowedTools'),
    allowedFileScopes: cleanList(def.allowedFileScopes, 'allowedFileScopes'),
    allowedActions: cleanList(def.allowedActions, 'allowedActions'),
    modelConfigRef: def.modelConfigRef?.trim() || null,
    timeoutSeconds,
    retryPolicy: { maxOutputRepairs: repairs },
    completionCriteria: (def.completionCriteria ?? []).map((c) => c.trim()).filter(Boolean),
  };
}

async function insertVersion(tx: Db, actor: Actor, agent: Agent, def: NormalizedDefinition): Promise<AgentVersion> {
  const [latest] = await tx
    .select({ no: agentVersions.versionNo })
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agent.id))
    .orderBy(desc(agentVersions.versionNo))
    .limit(1);
  const [created] = await tx
    .insert(agentVersions)
    .values({
      agentId: agent.id,
      versionNo: (latest?.no ?? 0) + 1,
      ...def,
      contentHash: hashJson(def),
      createdBy: actorId(actor),
    })
    .returning();
  await tx
    .update(agents)
    .set({ currentVersionId: created!.id, updatedAt: new Date(), version: agent.version + 1 })
    .where(eq(agents.id, agent.id));
  return created!;
}

export interface CreateAgentInput {
  agentKey: string;
  name: string;
  description?: string;
  role: string;
  definition: AgentDefinition;
}

export async function createAgent(db: Db, actor: Actor, input: CreateAgentInput): Promise<AgentView> {
  await requireAdmin(db, actor);
  const workspaceId = workspaceOf(actor);
  const agentKey = input.agentKey.trim().toLowerCase();
  if (!KEY_RE.test(agentKey)) {
    throw new ValidationError('agentKey must be 2-40 chars: lowercase letters, digits, underscores; start with a letter');
  }
  const name = input.name.trim();
  if (!name) throw new ValidationError('name is required');
  if (!isAgentRole(input.role)) throw new ValidationError(`Unknown agent role '${input.role}'`);
  const def = normalizeDefinition(input.definition);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [dup] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.agentKey, agentKey)))
      .limit(1);
    if (dup) throw new ConflictError(`Agent '${agentKey}' already exists`, 'agent_exists');
    const [agent] = await tx
      .insert(agents)
      .values({ workspaceId, agentKey, name, description: input.description?.trim() ?? '', role: input.role })
      .returning();
    const version = await insertVersion(tx, actor, agent!, def);
    await audit(tx, actor, {
      action: 'agent.created',
      targetType: 'agent',
      targetId: agent!.id,
      payload: { agentKey, role: input.role, versionNo: 1, contentHash: version.contentHash },
    });
    await emitEvent(tx, {
      type: 'agent.created',
      aggregateType: 'agent',
      aggregateId: agent!.id,
      workspaceId,
      payload: { agentKey, versionNo: 1 },
    });
    return { ...agent!, currentVersionId: version.id, currentVersion: version };
  });
}

async function loadAgent(db: Db, workspaceId: string, agentId: string): Promise<Agent> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  if (!agent) throw new NotFoundError('Agent', agentId);
  return agent;
}

/**
 * Publishes a new immutable version. Publishing a definition identical to the current version is a no-op
 * (same content hash), which makes seeding idempotent.
 */
export async function publishAgentVersion(
  db: Db,
  actor: Actor,
  agentId: string,
  definition: AgentDefinition,
): Promise<{ version: AgentVersion; created: boolean }> {
  await requireAdmin(db, actor);
  const workspaceId = workspaceOf(actor);
  const def = normalizeDefinition(definition);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const agent = await loadAgent(tx, workspaceId, agentId);
    if (agent.currentVersionId) {
      const [current] = await tx.select().from(agentVersions).where(eq(agentVersions.id, agent.currentVersionId));
      if (current && current.contentHash === hashJson(def)) return { version: current, created: false };
    }
    const version = await insertVersion(tx, actor, agent, def);
    await audit(tx, actor, {
      action: 'agent.version_published',
      targetType: 'agent',
      targetId: agent.id,
      payload: { agentKey: agent.agentKey, versionNo: version.versionNo, contentHash: version.contentHash },
    });
    await emitEvent(tx, {
      type: 'agent.version_published',
      aggregateType: 'agent',
      aggregateId: agent.id,
      workspaceId,
      payload: { agentKey: agent.agentKey, versionNo: version.versionNo },
    });
    return { version, created: true };
  });
}

export async function setAgentStatus(db: Db, actor: Actor, agentId: string, status: AgentStatus): Promise<Agent> {
  await requireAdmin(db, actor);
  const workspaceId = workspaceOf(actor);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const agent = await loadAgent(tx, workspaceId, agentId);
    const [updated] = await tx
      .update(agents)
      .set({ status, updatedAt: new Date(), version: agent.version + 1 })
      .where(eq(agents.id, agent.id))
      .returning();
    await audit(tx, actor, {
      action: 'agent.status_changed',
      targetType: 'agent',
      targetId: agent.id,
      payload: { agentKey: agent.agentKey, from: agent.status, to: status },
    });
    return updated!;
  });
}

async function withVersions(db: Db, rows: Agent[]): Promise<AgentView[]> {
  const out: AgentView[] = [];
  for (const agent of rows) {
    const [v] = agent.currentVersionId
      ? await db.select().from(agentVersions).where(eq(agentVersions.id, agent.currentVersionId))
      : [];
    out.push({ ...agent, currentVersion: v ?? null });
  }
  return out;
}

export async function listAgents(db: Db, actor: Actor): Promise<AgentView[]> {
  await authorize(db, actor, 'ai.config.read');
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, workspaceOf(actor)))
    .orderBy(agents.agentKey);
  return withVersions(db, rows);
}

export async function getAgent(db: Db, actor: Actor, agentId: string): Promise<AgentView> {
  await authorize(db, actor, 'ai.config.read');
  const [view] = await withVersions(db, [await loadAgent(db, workspaceOf(actor), agentId)]);
  return view!;
}

export async function listAgentVersions(db: Db, actor: Actor, agentId: string): Promise<AgentVersion[]> {
  await authorize(db, actor, 'ai.config.read');
  const agent = await loadAgent(db, workspaceOf(actor), agentId);
  return db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agent.id))
    .orderBy(desc(agentVersions.versionNo));
}

export interface ResolvedAgent {
  agent: Agent;
  version: AgentVersion;
}

/**
 * Finds the active agent that should execute a piece of work: by registry key when a workflow stage names
 * one, otherwise the active agent registered for the task's role. Internal — no authorization.
 */
export async function resolveAgent(
  db: Db,
  workspaceId: string,
  target: { agentKey?: string | null; role?: string | null },
): Promise<ResolvedAgent | null> {
  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.status, 'active'),
        target.agentKey ? eq(agents.agentKey, target.agentKey) : undefined,
        !target.agentKey && target.role ? eq(agents.role, target.role) : undefined,
      ),
    )
    .orderBy(agents.agentKey);
  if (!target.agentKey && !target.role) return null;
  // Prefer the agent whose key equals the role when several share a role.
  const agent = rows.find((a) => a.agentKey === (target.agentKey ?? target.role)) ?? rows[0];
  if (!agent?.currentVersionId) return null;
  const [version] = await db.select().from(agentVersions).where(eq(agentVersions.id, agent.currentVersionId));
  return version ? { agent, version } : null;
}
