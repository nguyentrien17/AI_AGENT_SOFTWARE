import { eq } from 'drizzle-orm';
import { type Db, projects, tasks } from '@platform/db';
import { authorize } from '@platform/iam';
import { type Actor, ForbiddenError, NotFoundError } from '@platform/shared';

/**
 * Agent roles known to the context access policy. In Phase 5 the Agent Registry maps each versioned
 * agent definition to one of these roles; until then an agent actor's `agentKey` is its role.
 */
export const AGENT_ROLES = [
  'orchestrator',
  'ba',
  'architect',
  'database',
  'api_designer',
  'developer',
  'qa',
  'review',
  'security',
  'documentation',
  'devops',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export function isAgentRole(v: string): v is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(v);
}

interface AreaRule {
  prefix: string;
  /** Agent roles that may write. `'$segment'` = role named by the next path segment (handoff folders). */
  writers: readonly AgentRole[] | '$segment';
  /** Humans with `artifact.write` may write here (Blueprint §7.7: requirements; plus unrestricted areas). */
  humanWrite: boolean;
  readers: readonly AgentRole[] | '*';
  /** Managed by the platform only (never through the artifact API). */
  system?: boolean;
}

const ALL_BUT_BA: readonly AgentRole[] = AGENT_ROLES.filter((r) => r !== 'ba');

/** Ordered most-specific first. Paths outside every rule are denied (deny-by-default). */
export const CONTEXT_AREAS: readonly AreaRule[] = [
  { prefix: '.ai-context/00-index/', writers: [], humanWrite: false, readers: '*', system: true },
  { prefix: '.ai-context/01-requirements/', writers: ['ba'], humanWrite: true, readers: '*' },
  { prefix: '.ai-context/02-architecture/', writers: ['architect'], humanWrite: false, readers: '*' },
  { prefix: '.ai-context/03-database/', writers: ['database'], humanWrite: false, readers: ALL_BUT_BA },
  { prefix: '.ai-context/04-api/', writers: ['architect', 'api_designer'], humanWrite: false, readers: '*' },
  { prefix: '.ai-context/05-agent-handoffs/', writers: '$segment', humanWrite: false, readers: '*' },
  { prefix: '.ai-context/06-tasks/', writers: ['orchestrator'], humanWrite: false, readers: '*' },
  { prefix: '.ai-context/07-quality/test-results/', writers: ['qa'], humanWrite: false, readers: '*' },
  {
    prefix: '.ai-context/07-quality/review-reports/',
    writers: ['review', 'security'],
    humanWrite: false,
    readers: '*',
  },
  { prefix: '.ai-context/07-quality/', writers: ['qa', 'review'], humanWrite: false, readers: '*' },
  { prefix: '.ai-context/08-knowledge/', writers: ['architect', 'ba'], humanWrite: true, readers: '*' },
  { prefix: '.ai-context/09-decisions/', writers: ['architect'], humanWrite: false, readers: '*' },
  {
    prefix: '.ai-context/10-checkpoints/',
    writers: [],
    humanWrite: false,
    readers: ['orchestrator'],
    system: true,
  },
  { prefix: '.ai-context/11-audit/', writers: [], humanWrite: false, readers: [], system: true },
  { prefix: 'documentation/', writers: ['documentation', 'architect'], humanWrite: true, readers: '*' },
];

export function areaFor(path: string): AreaRule | null {
  return CONTEXT_AREAS.find((a) => path.startsWith(a.prefix)) ?? null;
}

export function isSystemManagedPath(path: string): boolean {
  return areaFor(path)?.system === true;
}

export function canRoleWrite(role: string, path: string): boolean {
  const area = areaFor(path);
  if (!area || area.system || !isAgentRole(role)) return false;
  if (area.writers === '$segment') {
    const segment = path.slice(area.prefix.length).split('/')[0];
    return segment === role;
  }
  return area.writers.includes(role);
}

export function canRoleRead(role: string, path: string): boolean {
  const area = areaFor(path);
  if (!area || !isAgentRole(role)) return false;
  return area.readers === '*' || area.readers.includes(role);
}

export function describeWriters(path: string): string {
  const area = areaFor(path);
  if (!area) return 'nobody';
  if (area.system) return 'the platform';
  if (area.writers === '$segment') return 'the agent named by the folder';
  return (
    [...area.writers.map((w) => `${w} agent`), ...(area.humanWrite ? ['authorized humans'] : [])].join(
      ', ',
    ) || 'nobody'
  );
}

const ACTIVE_FOR_WRITE = new Set(['assigned', 'running']);
const ACTIVE_FOR_READ = new Set(['assigned', 'running', 'waiting_for_input', 'waiting_for_approval']);

/**
 * An agent may only act inside a project while bound to a task of that project that is assigned to its role
 * and currently active (Blueprint §16.2: Project × Agent × Task …). Leases are added in Phase 5.
 */
export async function requireAgentTaskBinding(
  db: Db,
  actor: Extract<Actor, { type: 'agent' }>,
  projectId: string,
  mode: 'read' | 'write',
): Promise<typeof tasks.$inferSelect> {
  if (!actor.taskId) throw new ForbiddenError('Agent actions require a task binding');
  const [task] = await db.select().from(tasks).where(eq(tasks.id, actor.taskId)).limit(1);
  if (!task) throw new NotFoundError('Task', actor.taskId);
  const [project] = await db
    .select({ ws: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || project.ws !== actor.workspaceId || task.projectId !== projectId) {
    throw new ForbiddenError('Agent task binding does not belong to this project');
  }
  if (task.agentRole !== actor.agentKey) {
    throw new ForbiddenError(
      `Task is assigned to role '${task.agentRole ?? 'none'}', not '${actor.agentKey}'`,
    );
  }
  const allowed = mode === 'write' ? ACTIVE_FOR_WRITE : ACTIVE_FOR_READ;
  if (!allowed.has(task.status))
    throw new ForbiddenError(`Task status '${task.status}' does not permit agent ${mode} access`);
  return task;
}

export async function authorizeArtifactWrite(
  db: Db,
  actor: Actor,
  projectId: string,
  path: string,
): Promise<void> {
  const area = areaFor(path);
  if (!area || area.system) throw new ForbiddenError(`'${path}' is managed by the platform`);
  if (actor.type === 'system') return;
  if (actor.type === 'user') {
    await authorize(db, actor, 'artifact.write', { projectId });
    if (!area.humanWrite)
      throw new ForbiddenError(`'${area.prefix}' is writable only by ${describeWriters(path)}`);
    return;
  }
  await requireAgentTaskBinding(db, actor, projectId, 'write');
  if (!canRoleWrite(actor.agentKey, path)) {
    throw new ForbiddenError(
      `Agent role '${actor.agentKey}' cannot write '${path}' (owned by ${describeWriters(path)})`,
    );
  }
}

export async function authorizeArtifactRead(
  db: Db,
  actor: Actor,
  projectId: string,
  path: string,
): Promise<void> {
  if (actor.type === 'system') return;
  if (actor.type === 'user') {
    await authorize(db, actor, 'artifact.read', { projectId });
    return;
  }
  await requireAgentTaskBinding(db, actor, projectId, 'read');
  if (!canRoleRead(actor.agentKey, path))
    throw new ForbiddenError(`Agent role '${actor.agentKey}' cannot read '${path}'`);
}
