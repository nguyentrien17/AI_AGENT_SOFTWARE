import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  authorizeArtifactRead,
  canRoleRead,
  findArtifactByPath,
  isAgentRole,
  loadVersionContent,
  normalizeArtifactPath,
  requireAgentTaskBinding,
  type ArtifactDeps,
} from '@platform/artifacts';
import {
  contextItems,
  contextPackageItems,
  contextPackages,
  contextVersions,
  type Db,
  isUniqueViolation,
  projectMemories,
  projects,
  taskDependencies,
  tasks,
} from '@platform/db';
import { authorize } from '@platform/iam';
import { audit } from '@platform/observability';
import {
  type Actor,
  ConflictError,
  ForbiddenError,
  hashJson,
  NotFoundError,
  uuidv7,
  ValidationError,
} from '@platform/shared';
import { latestHandoffsForTasks } from './handoff.js';
import { estimateTokens, estimateTokensFromBytes } from './tokens.js';

export type Relevance = 'high' | 'medium' | 'low';
export type ItemSource = 'explicit' | 'handoff' | 'default';

/** Small curated defaults per role; included only when they exist as approved artifacts. */
export const ROLE_DEFAULT_CONTEXT: Readonly<Record<string, readonly string[]>> = {
  ba: ['.ai-context/08-knowledge/glossary.md'],
  architect: ['.ai-context/01-requirements/overview.md', '.ai-context/08-knowledge/glossary.md'],
  database: [
    '.ai-context/02-architecture/system-architecture.md',
    '.ai-context/02-architecture/module-design.md',
  ],
  api_designer: ['.ai-context/02-architecture/system-architecture.md'],
  developer: ['.ai-context/08-knowledge/coding-standards.md', '.ai-context/08-knowledge/conventions.md'],
  qa: ['.ai-context/01-requirements/acceptance-criteria.md', '.ai-context/08-knowledge/coding-standards.md'],
  review: [
    '.ai-context/08-knowledge/coding-standards.md',
    '.ai-context/08-knowledge/conventions.md',
    '.ai-context/02-architecture/technical-decisions.md',
  ],
  security: ['.ai-context/02-architecture/system-architecture.md'],
  documentation: ['.ai-context/01-requirements/overview.md', '.ai-context/08-knowledge/glossary.md'],
  devops: ['.ai-context/02-architecture/system-architecture.md'],
  orchestrator: [],
};

export const DEFAULT_CONTEXT_BUDGET_TOKENS = 30_000;
const RELEVANCE_RANK: Record<Relevance, number> = { high: 3, medium: 2, low: 1 };
const SOURCE_RANK: Record<ItemSource, number> = { explicit: 3, handoff: 2, default: 1 };

export interface ManifestItem {
  type: string;
  ref: string;
  item_id: string;
  path: string;
  version: number;
  hash: string;
  size_bytes: number;
  estimated_tokens: number;
  relevance: Relevance;
  source: ItemSource;
  aliases?: string[];
  note?: string;
}

export interface ContextPackageManifest {
  schema_version: '1.0';
  package_id: string;
  project_id: string;
  task_id: string;
  agent_role: string;
  context_version: number;
  items: ManifestItem[];
  constraints: Array<{ id: string; content: string }>;
  dependencies: string[];
  excluded: Array<{ path: string; reason: string }>;
  watched_paths: string[];
  estimated_tokens: number;
  token_budget: number;
  cache_key: string;
  prompt_version: string;
  model_config_version: string;
  created_at: string;
}

export interface BuildPackageInput {
  taskId: string;
  agentRole?: string;
  tokenBudget?: number;
  promptVersion?: string;
  modelConfigVersion?: string;
}

export interface BuildPackageResult {
  packageId: string;
  manifest: ContextPackageManifest;
  cacheHit: boolean;
}

interface Candidate {
  path: string;
  relevance: Relevance;
  source: ItemSource;
  required: boolean;
  pinnedVersion?: number;
  pinnedHash?: string;
}

type VersionRow = typeof contextVersions.$inferSelect;
type ItemRow = typeof contextItems.$inferSelect;

/** Hash of the task fields that influence what an agent must do (part of the cache key). */
export function taskSpecHash(t: typeof tasks.$inferSelect): string {
  return hashJson({
    title: t.title,
    objective: t.objective,
    inputRefs: t.inputRefs,
    expectedOutput: t.expectedOutput,
    acceptanceCriteria: t.acceptanceCriteria,
    agentRole: t.agentRole,
    allowedTools: [...t.allowedTools].sort(),
  });
}

export function computeCacheKey(parts: {
  taskSpecHash: string;
  artifactHashes: string[];
  constraintsHash: string;
  promptVersion: string;
  agentRole: string;
  modelConfigVersion: string;
  tokenBudget: number;
}): string {
  return hashJson({ ...parts, artifactHashes: [...parts.artifactHashes].sort() });
}

async function authorizeBuild(db: Db, actor: Actor, task: typeof tasks.$inferSelect, agentRole: string) {
  if (actor.type === 'system') return;
  if (actor.type === 'user') {
    await authorize(db, actor, 'task.read', { projectId: task.projectId });
    return;
  }
  if (actor.agentKey !== agentRole)
    throw new ForbiddenError('Agents may only build packages for their own role');
  await requireAgentTaskBinding(db, actor, task.projectId, 'read');
  if (actor.taskId !== task.id)
    throw new ForbiddenError('Agents may only build packages for their bound task');
}

/**
 * Context Manager workflow (Blueprint §7.4): resolves explicit inputs, upstream handoff outputs and role defaults
 * into a minimal, permission-checked, hash-verified, deduplicated and token-bounded immutable manifest.
 * Identical inputs yield the identical cache key, and a valid cached package is reused.
 */
export async function buildContextPackage(
  deps: ArtifactDeps,
  actor: Actor,
  input: BuildPackageInput,
): Promise<BuildPackageResult> {
  const { db } = deps;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
  if (!task) throw new NotFoundError('Task', input.taskId);
  const agentRole = input.agentRole ?? task.agentRole;
  if (!agentRole || !isAgentRole(agentRole)) {
    throw new ValidationError('A valid agent role is required to build a context package', [
      { path: 'agentRole', message: 'unknown or missing role' },
    ]);
  }
  await authorizeBuild(db, actor, task, agentRole);
  const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1);
  if (!project) throw new NotFoundError('Project', task.projectId);

  const tokenBudget = input.tokenBudget ?? task.tokenCeiling ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1)
    throw new ValidationError('tokenBudget must be a positive integer');
  const promptVersion = input.promptVersion ?? 'none';
  const modelConfigVersion = input.modelConfigVersion ?? 'none';

  // 1-3. Candidate discovery: explicit inputs, upstream dependency outputs, role defaults.
  const candidates: Candidate[] = [];
  for (const ref of task.inputRefs) {
    candidates.push({
      path: normalizeArtifactPath(ref.path),
      relevance: 'high',
      source: 'explicit',
      required: true,
      ...(ref.version ? { pinnedVersion: ref.version } : {}),
    });
  }
  const depRows = await db
    .select({ id: taskDependencies.dependsOnTaskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, task.id));
  const dependencyIds = depRows.map((d) => d.id).sort();
  if (dependencyIds.length) {
    const depTasks = await db
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, dependencyIds));
    const incomplete = depTasks.filter((d) => d.status !== 'completed');
    if (incomplete.length) {
      throw new ConflictError(
        `Upstream dependencies are not completed: ${incomplete.map((d) => d.id).join(', ')}`,
        'dependencies_incomplete',
      );
    }
    for (const h of await latestHandoffsForTasks(db, dependencyIds)) {
      const refs = (h.payload as { output_refs: Array<{ path: string; version: number; sha256: string }> })
        .output_refs;
      for (const r of refs) {
        candidates.push({
          path: r.path,
          relevance: 'high',
          source: 'handoff',
          required: true,
          pinnedVersion: r.version,
          pinnedHash: r.sha256,
        });
      }
    }
  }
  for (const p of ROLE_DEFAULT_CONTEXT[agentRole] ?? []) {
    candidates.push({ path: p, relevance: 'medium', source: 'default', required: false });
  }
  const watchedPaths = [...new Set(candidates.map((c) => c.path))].sort();

  // 4-5. Permission check and version resolution.
  const excluded: Array<{ path: string; reason: string }> = [];
  const resolved: Array<{ c: Candidate; item: ItemRow; version: VersionRow; note?: string }> = [];
  for (const c of candidates) {
    if (!canRoleRead(agentRole, c.path)) {
      if (c.required)
        throw new ForbiddenError(`Role '${agentRole}' is not permitted to read required input '${c.path}'`);
      excluded.push({ path: c.path, reason: 'forbidden_for_role' });
      continue;
    }
    const item = await findArtifactByPath(db, project.id, c.path);
    if (!item) {
      if (c.required) throw new NotFoundError('Required context artifact', c.path);
      excluded.push({ path: c.path, reason: 'not_found' });
      continue;
    }
    let versionNo: number | null;
    let note: string | undefined;
    if (c.source === 'handoff') {
      // Upstream output pinned by version+hash; a newer human-approved version supersedes it.
      versionNo =
        item.approvedVersionNo !== null && item.approvedVersionNo > c.pinnedVersion!
          ? item.approvedVersionNo
          : c.pinnedVersion!;
      if (versionNo !== c.pinnedVersion) note = `supersedes handoff v${c.pinnedVersion}`;
    } else if (c.pinnedVersion) {
      versionNo = c.pinnedVersion;
    } else {
      versionNo = item.approvedVersionNo;
      if (versionNo === null) {
        if (c.required) {
          throw new ConflictError(
            `Required input '${c.path}' has no approved version`,
            'no_approved_version',
          );
        }
        excluded.push({ path: c.path, reason: 'no_approved_version' });
        continue;
      }
    }
    const [version] = await db
      .select()
      .from(contextVersions)
      .where(and(eq(contextVersions.contextItemId, item.id), eq(contextVersions.versionNo, versionNo)))
      .limit(1);
    if (!version) throw new NotFoundError('Context artifact version', `${c.path}@${versionNo}`);
    if (c.source === 'handoff' && versionNo === c.pinnedVersion && version.sha256 !== c.pinnedHash) {
      throw new ConflictError(
        `Handoff reference hash mismatch for '${c.path}@${versionNo}'`,
        'handoff_hash_mismatch',
      );
    }
    resolved.push({ c, item, version, ...(note ? { note } : {}) });
  }

  // 9. Deduplicate: by exact version (keep strongest relevance/source), then by identical content hash.
  const byVersion = new Map<string, (typeof resolved)[number]>();
  for (const r of resolved) {
    const prev = byVersion.get(r.version.id);
    if (
      !prev ||
      RELEVANCE_RANK[r.c.relevance] > RELEVANCE_RANK[prev.c.relevance] ||
      (RELEVANCE_RANK[r.c.relevance] === RELEVANCE_RANK[prev.c.relevance] &&
        SOURCE_RANK[r.c.source] > SOURCE_RANK[prev.c.source])
    ) {
      byVersion.set(r.version.id, r);
    }
  }
  const bySha = new Map<string, { r: (typeof resolved)[number]; aliases: string[] }>();
  for (const r of [...byVersion.values()].sort((a, b) => a.item.path.localeCompare(b.item.path))) {
    const prev = bySha.get(r.version.sha256);
    if (prev) prev.aliases.push(r.item.path);
    else bySha.set(r.version.sha256, { r, aliases: [] });
  }

  // Constraints from project memory.
  const constraintRows = await db
    .select({ id: projectMemories.id, content: projectMemories.content })
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.projectId, project.id),
        eq(projectMemories.kind, 'constraint'),
        isNull(projectMemories.archivedAt),
      ),
    )
    .orderBy(projectMemories.id);
  const constraints = constraintRows.map((r) => ({ id: r.id, content: r.content }));
  const constraintTokens = constraints.reduce((s, c) => s + estimateTokens(c.content), 0);

  // 8. Token budget: drop optional (non-high) items largest-first; never drop required/high items.
  let items: Array<{ r: (typeof resolved)[number]; aliases: string[]; tokens: number }> = [
    ...bySha.values(),
  ].map((x) => ({
    ...x,
    tokens: estimateTokensFromBytes(x.r.version.sizeBytes),
  }));
  let total = constraintTokens + items.reduce((s, i) => s + i.tokens, 0);
  if (total > tokenBudget) {
    const optional = items.filter((i) => i.r.c.relevance !== 'high').sort((a, b) => b.tokens - a.tokens);
    for (const o of optional) {
      if (total <= tokenBudget) break;
      items = items.filter((i) => i !== o);
      total -= o.tokens;
      excluded.push({ path: o.r.item.path, reason: 'token_budget' });
    }
    if (total > tokenBudget) {
      throw new ConflictError(
        `Required context (${total} tokens) exceeds the budget of ${tokenBudget} tokens; increase the budget or reduce task scope`,
        'context_budget_exceeded',
        { estimatedTokens: total, tokenBudget },
      );
    }
  }

  const manifestItems: ManifestItem[] = items
    .map(({ r, aliases, tokens }) => ({
      type: r.item.type,
      ref: r.version.id,
      item_id: r.item.id,
      path: r.item.path,
      version: r.version.versionNo,
      hash: r.version.sha256,
      size_bytes: r.version.sizeBytes,
      estimated_tokens: tokens,
      relevance: r.c.relevance,
      source: r.c.source,
      ...(aliases.length ? { aliases } : {}),
      ...(r.note ? { note: r.note } : {}),
    }))
    .sort(
      (a, b) => RELEVANCE_RANK[b.relevance] - RELEVANCE_RANK[a.relevance] || a.path.localeCompare(b.path),
    );

  const cacheKey = computeCacheKey({
    taskSpecHash: taskSpecHash(task),
    artifactHashes: manifestItems.map((i) => `${i.ref}:${i.hash}`),
    constraintsHash: hashJson(constraints),
    promptVersion,
    agentRole,
    modelConfigVersion,
    tokenBudget,
  });

  // 6. Cache lookup.
  const cached = await findValidPackageByKey(db, cacheKey);
  if (cached)
    return {
      packageId: cached.id,
      manifest: cached.manifest as unknown as ContextPackageManifest,
      cacheHit: true,
    };

  // 6. Verify content hashes against storage before publishing a new package.
  for (const i of items) await loadVersionContent(deps.storage, project, i.r.version);

  const packageId = uuidv7();
  const manifest: ContextPackageManifest = {
    schema_version: '1.0',
    package_id: packageId,
    project_id: project.id,
    task_id: task.id,
    agent_role: agentRole,
    context_version: project.contextVersion,
    items: manifestItems,
    constraints,
    dependencies: dependencyIds,
    excluded: excluded.sort((a, b) => a.path.localeCompare(b.path)),
    watched_paths: watchedPaths,
    estimated_tokens: total,
    token_budget: tokenBudget,
    cache_key: cacheKey,
    prompt_version: promptVersion,
    model_config_version: modelConfigVersion,
    created_at: new Date().toISOString(),
  };

  try {
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.insert(contextPackages).values({
        id: packageId,
        projectId: project.id,
        taskId: task.id,
        agentRole,
        cacheKey,
        contextVersion: project.contextVersion,
        estimatedTokens: total,
        tokenBudget,
        promptVersion,
        modelConfigVersion,
        manifest: manifest as unknown as Record<string, unknown>,
        manifestHash: hashJson(manifest),
      });
      if (manifestItems.length) {
        await tx.insert(contextPackageItems).values(
          manifestItems.map((i) => ({
            packageId,
            contextVersionId: i.ref,
            contextItemId: i.item_id,
            relevance: i.relevance,
            source: i.source,
          })),
        );
      }
      await audit(tx, actor, {
        action: 'context.package.build',
        targetType: 'context_package',
        targetId: packageId,
        projectId: project.id,
        payload: {
          taskId: task.id,
          agentRole,
          items: manifestItems.length,
          estimatedTokens: total,
          cacheKey,
        },
      });
    });
  } catch (e) {
    // Concurrent build with identical inputs: return the winner.
    if (isUniqueViolation(e)) {
      const winner = await findValidPackageByKey(db, cacheKey);
      if (winner)
        return {
          packageId: winner.id,
          manifest: winner.manifest as unknown as ContextPackageManifest,
          cacheHit: true,
        };
    }
    throw e;
  }
  return { packageId, manifest, cacheHit: false };
}

async function findValidPackageByKey(db: Db, cacheKey: string) {
  const [row] = await db
    .select()
    .from(contextPackages)
    .where(and(eq(contextPackages.cacheKey, cacheKey), isNull(contextPackages.invalidatedAt)))
    .limit(1);
  return row ?? null;
}

export class StalePackageError extends ConflictError {
  constructor(id: string, reason: string | null) {
    super(
      `Context package ${id} was invalidated${reason ? ` (${reason})` : ''}; rebuild it`,
      'context_package_stale',
    );
  }
}

export interface LoadedContextItem extends ManifestItem {
  content: string;
}

export interface LoadedContextPackage {
  packageId: string;
  manifest: ContextPackageManifest;
  items: LoadedContextItem[];
}

/**
 * Consumption by an agent: rejects invalidated packages, re-verifies every item's SHA-256 against the manifest,
 * and returns the curated content. No chat transcript is involved.
 */
export async function loadContextPackage(
  deps: ArtifactDeps,
  actor: Actor,
  packageId: string,
): Promise<LoadedContextPackage> {
  const [pkg] = await deps.db
    .select()
    .from(contextPackages)
    .where(eq(contextPackages.id, packageId))
    .limit(1);
  if (!pkg) throw new NotFoundError('Context package', packageId);
  if (actor.type === 'agent') {
    if (actor.agentKey !== pkg.agentRole || actor.taskId !== pkg.taskId) {
      throw new ForbiddenError('This context package was built for a different agent/task');
    }
    await requireAgentTaskBinding(deps.db, actor, pkg.projectId, 'read');
  } else if (actor.type === 'user') {
    await authorize(deps.db, actor, 'artifact.read', { projectId: pkg.projectId });
  }
  if (pkg.invalidatedAt) throw new StalePackageError(pkg.id, pkg.invalidationReason);
  const manifest = pkg.manifest as unknown as ContextPackageManifest;
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, pkg.projectId)).limit(1);
  const versions = manifest.items.length
    ? await deps.db
        .select()
        .from(contextVersions)
        .where(
          inArray(
            contextVersions.id,
            manifest.items.map((i) => i.ref),
          ),
        )
    : [];
  const items: LoadedContextItem[] = [];
  for (const mi of manifest.items) {
    const v = versions.find((x) => x.id === mi.ref);
    if (!v || v.sha256 !== mi.hash)
      throw new ConflictError(`Manifest item ${mi.path} no longer matches storage`, 'integrity_error');
    if (actor.type === 'agent') await authorizeArtifactRead(deps.db, actor, pkg.projectId, mi.path);
    const content = await loadVersionContent(deps.storage, project!, v);
    items.push({ ...mi, content: content.toString('utf8') });
  }
  return { packageId: pkg.id, manifest, items };
}

/** Latest valid package for a task (or null). */
export async function getLatestTaskPackage(db: Db, actor: Actor, taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) throw new NotFoundError('Task', taskId);
  await authorize(db, actor, 'task.read', { projectId: task.projectId });
  const [pkg] = await db
    .select()
    .from(contextPackages)
    .where(and(eq(contextPackages.taskId, taskId), isNull(contextPackages.invalidatedAt)))
    .orderBy(desc(contextPackages.createdAt))
    .limit(1);
  return pkg ?? null;
}

export async function getContextPackage(db: Db, actor: Actor, packageId: string) {
  const [pkg] = await db.select().from(contextPackages).where(eq(contextPackages.id, packageId)).limit(1);
  if (!pkg) throw new NotFoundError('Context package', packageId);
  await authorize(db, actor, 'task.read', { projectId: pkg.projectId });
  return pkg;
}
