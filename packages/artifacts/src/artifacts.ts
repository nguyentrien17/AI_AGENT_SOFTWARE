import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  contextItems,
  contextPackages,
  contextVersions,
  type Db,
  isUniqueViolation,
  projects,
} from '@platform/db';
import { audit, emitEvent } from '@platform/observability';
import {
  type Actor,
  actorId,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  sha256Hex,
  ValidationError,
  VersionConflictError,
  clampLimit,
  type Page,
  type PageRequest,
  toPage,
} from '@platform/shared';
import { IntegrityError, type StorageAdapter } from '@platform/storage';
import { authorize } from '@platform/iam';
import { authorizeArtifactRead, authorizeArtifactWrite, isSystemManagedPath } from './access-policy.js';

export interface ArtifactDeps {
  db: Db;
  storage: StorageAdapter;
}

export type ArtifactItem = typeof contextItems.$inferSelect;
export type ArtifactVersion = typeof contextVersions.$inferSelect;
type Project = typeof projects.$inferSelect;

/** Artifacts may only live in curated, versioned areas of the project workspace. */
const ALLOWED_ROOTS = ['.ai-context/', 'documentation/'];
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export function normalizeArtifactPath(p: string): string {
  const norm = p
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  if (
    !norm ||
    norm.startsWith('/') ||
    /^[a-zA-Z]:/.test(norm) ||
    norm.split('/').some((s) => s === '..' || s === '.' || s === '')
  ) {
    throw new ValidationError(`Invalid artifact path '${p}'`, [
      { path: 'path', message: 'must be a clean relative path' },
    ]);
  }
  if (!ALLOWED_ROOTS.some((r) => norm.startsWith(r))) {
    throw new ValidationError(`Artifact path must be under ${ALLOWED_ROOTS.join(' or ')}`, [
      { path: 'path', message: 'outside curated roots' },
    ]);
  }
  if (isSystemManagedPath(norm) || norm.endsWith('/.gitkeep')) {
    throw new ValidationError('This path is managed by the platform', [
      { path: 'path', message: 'reserved' },
    ]);
  }
  return norm;
}

async function loadProject(db: Db, projectId: string): Promise<Project> {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) throw new NotFoundError('Project', projectId);
  return p;
}

async function loadItem(db: Db, itemId: string): Promise<ArtifactItem> {
  const [i] = await db.select().from(contextItems).where(eq(contextItems.id, itemId)).limit(1);
  if (!i) throw new NotFoundError('Artifact', itemId);
  return i;
}

function toBuffer(content: string | Buffer): Buffer {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  if (buf.length > MAX_ARTIFACT_BYTES)
    throw new ValidationError(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  return buf;
}

function blobStore(storage: StorageAdapter, storagePath: string): StorageAdapter {
  return storage.scoped(storagePath).scoped('artifacts');
}

/** Bumps the project-wide monotonic context version and returns the new value. */
async function bumpContextVersion(tx: Db, projectId: string): Promise<number> {
  const [row] = await tx
    .update(projects)
    .set({ contextVersion: sql`${projects.contextVersion} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ v: projects.contextVersion });
  return row!.v;
}

/**
 * Immediately invalidates every valid context package that watches `path` (Blueprint §7.5: when any underlying
 * source artifact mutates, dependent cached packages must be invalidated). Runs inside the mutating transaction.
 */
export async function invalidatePackagesWatching(
  tx: Db,
  projectId: string,
  path: string,
  reason: string,
): Promise<number> {
  const rows = await tx
    .update(contextPackages)
    .set({ invalidatedAt: new Date(), invalidationReason: reason })
    .where(
      and(
        eq(contextPackages.projectId, projectId),
        isNull(contextPackages.invalidatedAt),
        sql`${contextPackages.manifest} -> 'watched_paths' @> ${JSON.stringify([path])}::jsonb`,
      ),
    )
    .returning({ id: contextPackages.id });
  return rows.length;
}

async function afterMutation(
  tx: Db,
  project: Project,
  item: { id: string; path: string },
  event: 'artifact.created' | 'artifact.versioned' | 'artifact.approved',
  payload: Record<string, unknown>,
) {
  const contextVersion = await bumpContextVersion(tx, project.id);
  const invalidated = await invalidatePackagesWatching(tx, project.id, item.path, `${event}: ${item.path}`);
  await emitEvent(tx, {
    type: event,
    aggregateType: 'artifact',
    aggregateId: item.id,
    workspaceId: project.workspaceId,
    projectId: project.id,
    payload: { path: item.path, ...payload, context_version: contextVersion },
  });
  await emitEvent(tx, {
    type: 'context.updated',
    aggregateType: 'project',
    aggregateId: project.id,
    workspaceId: project.workspaceId,
    projectId: project.id,
    payload: { context_version: contextVersion, path: item.path, invalidated_packages: invalidated },
  });
}

/**
 * Regenerates `.ai-context/00-index/context-map.json` from the database (DB is the SSOT for metadata; the file
 * is a derived, platform-managed index for humans and tooling).
 */
export async function syncContextMap(deps: ArtifactDeps, projectId: string): Promise<void> {
  const project = await loadProject(deps.db, projectId);
  const items = await deps.db
    .select()
    .from(contextItems)
    .where(eq(contextItems.projectId, projectId))
    .orderBy(asc(contextItems.path));
  const versions = items.length
    ? await deps.db
        .select({
          itemId: contextVersions.contextItemId,
          versionNo: contextVersions.versionNo,
          sha256: contextVersions.sha256,
        })
        .from(contextVersions)
        .innerJoin(contextItems, eq(contextItems.id, contextVersions.contextItemId))
        .where(eq(contextItems.projectId, projectId))
    : [];
  const sha = (itemId: string, no: number | null) =>
    no === null ? null : (versions.find((v) => v.itemId === itemId && v.versionNo === no)?.sha256 ?? null);
  const map = {
    schema_version: '1.0',
    project_id: projectId,
    context_version: project.contextVersion,
    items: items.map((i) => ({
      id: i.id,
      path: i.path,
      type: i.type,
      owner_role: i.ownerRole,
      current_version: i.currentVersionNo,
      current_sha256: sha(i.id, i.currentVersionNo),
      approved_version: i.approvedVersionNo,
      approved_sha256: sha(i.id, i.approvedVersionNo),
    })),
  };
  await deps.storage
    .scoped(project.storagePath)
    .writeAtomic('.ai-context/00-index/context-map.json', JSON.stringify(map, null, 2) + '\n');
}

async function writeWorkingCopy(deps: ArtifactDeps, project: Project, path: string, buf: Buffer) {
  await deps.storage.scoped(project.storagePath).writeAtomic(path, buf);
  await syncContextMap(deps, project.id);
}

export async function createArtifact(
  deps: ArtifactDeps,
  actor: Actor,
  projectId: string,
  input: { path: string; type: string; content: string | Buffer; ownerRole?: string; changeNote?: string },
): Promise<{ item: ArtifactItem; version: ArtifactVersion }> {
  const path = normalizeArtifactPath(input.path);
  await authorizeArtifactWrite(deps.db, actor, projectId, path);
  const project = await loadProject(deps.db, projectId);
  const type = input.type.trim();
  if (!type) throw new ValidationError('Artifact type is required');
  const buf = toBuffer(input.content);
  const blob = await blobStore(deps.storage, project.storagePath).putBlob(buf);

  let result: { item: ArtifactItem; version: ArtifactVersion };
  try {
    result = await deps.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [item] = await tx
        .insert(contextItems)
        .values({
          projectId,
          path,
          type,
          ownerRole: input.ownerRole ?? (actor.type === 'agent' ? actor.agentKey : null),
          currentVersionNo: 1,
        })
        .returning();
      const [version] = await tx
        .insert(contextVersions)
        .values({
          contextItemId: item!.id,
          versionNo: 1,
          sha256: blob.sha256,
          sizeBytes: blob.sizeBytes,
          storageUri: blob.uri,
          authorType: actor.type,
          authorId: actorId(actor),
          changeNote: input.changeNote ?? '',
        })
        .returning();
      await audit(tx, actor, {
        action: 'artifact.create',
        targetType: 'artifact',
        targetId: item!.id,
        projectId,
        payload: { path, sha256: blob.sha256 },
      });
      await afterMutation(tx, project, item!, 'artifact.created', { version: 1, sha256: blob.sha256 });
      return { item: item!, version: version! };
    });
  } catch (e) {
    if (isUniqueViolation(e))
      throw new ConflictError(
        `Artifact '${path}' already exists; create a new version instead`,
        'artifact_exists',
      );
    throw e;
  }
  await writeWorkingCopy(deps, project, path, buf);
  return result;
}

/**
 * Appends a new immutable version. `expectedVersionNo` implements optimistic concurrency: the caller must
 * have seen the current latest version.
 */
export async function createArtifactVersion(
  deps: ArtifactDeps,
  actor: Actor,
  itemId: string,
  input: { content: string | Buffer; expectedVersionNo: number; changeNote?: string },
): Promise<{ item: ArtifactItem; version: ArtifactVersion }> {
  const item = await loadItem(deps.db, itemId);
  await authorizeArtifactWrite(deps.db, actor, item.projectId, item.path);
  const project = await loadProject(deps.db, item.projectId);
  const buf = toBuffer(input.content);
  const blob = await blobStore(deps.storage, project.storagePath).putBlob(buf);
  const nextNo = input.expectedVersionNo + 1;

  let result: { item: ArtifactItem; version: ArtifactVersion };
  try {
    result = await deps.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [updated] = await tx
        .update(contextItems)
        .set({ currentVersionNo: nextNo, version: sql`${contextItems.version} + 1` })
        .where(and(eq(contextItems.id, itemId), eq(contextItems.currentVersionNo, input.expectedVersionNo)))
        .returning();
      if (!updated) {
        const cur = await loadItem(tx, itemId);
        throw new VersionConflictError('Artifact', input.expectedVersionNo, cur.currentVersionNo);
      }
      const [version] = await tx
        .insert(contextVersions)
        .values({
          contextItemId: itemId,
          versionNo: nextNo,
          sha256: blob.sha256,
          sizeBytes: blob.sizeBytes,
          storageUri: blob.uri,
          authorType: actor.type,
          authorId: actorId(actor),
          changeNote: input.changeNote ?? '',
        })
        .returning();
      await audit(tx, actor, {
        action: 'artifact.version',
        targetType: 'artifact',
        targetId: itemId,
        projectId: item.projectId,
        payload: { version: nextNo, sha256: blob.sha256 },
      });
      await afterMutation(tx, project, item, 'artifact.versioned', { version: nextNo, sha256: blob.sha256 });
      return { item: updated, version: version! };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const cur = await loadItem(deps.db, itemId);
      throw new VersionConflictError('Artifact', input.expectedVersionNo, cur.currentVersionNo);
    }
    throw e;
  }
  await writeWorkingCopy(deps, project, item.path, buf);
  return result;
}

/** Human approval of a specific version. The previously approved version becomes `superseded`. */
export async function approveArtifactVersion(
  deps: ArtifactDeps,
  actor: Actor,
  itemId: string,
  versionNo: number,
): Promise<ArtifactVersion> {
  const head = await loadItem(deps.db, itemId);
  if (actor.type !== 'user') throw new ForbiddenError('Only human users can approve artifacts');
  await authorize(deps.db, actor, 'artifact.approve', { projectId: head.projectId });
  const project = await loadProject(deps.db, head.projectId);
  const approved = await deps.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // Lock the head row so concurrent approvals serialize.
    const [item] = await tx.select().from(contextItems).where(eq(contextItems.id, itemId)).for('update');
    if (!item) throw new NotFoundError('Artifact', itemId);
    const [v] = await tx
      .select()
      .from(contextVersions)
      .where(and(eq(contextVersions.contextItemId, itemId), eq(contextVersions.versionNo, versionNo)))
      .limit(1);
    if (!v) throw new NotFoundError('Artifact version', `${itemId}@${versionNo}`);
    if (v.status === 'approved') return v;
    if (v.status === 'superseded')
      throw new ConflictError('Superseded versions cannot be approved', 'version_superseded');
    if (item.approvedVersionNo !== null && item.approvedVersionNo > versionNo) {
      throw new ConflictError('A newer version is already approved', 'newer_version_approved');
    }
    if (item.approvedVersionNo !== null) {
      await tx
        .update(contextVersions)
        .set({ status: 'superseded' })
        .where(
          and(
            eq(contextVersions.contextItemId, itemId),
            eq(contextVersions.versionNo, item.approvedVersionNo),
          ),
        );
    }
    const [row] = await tx
      .update(contextVersions)
      .set({ status: 'approved', approvedAt: new Date(), approvedBy: actor.userId })
      .where(eq(contextVersions.id, v.id))
      .returning();
    await tx
      .update(contextItems)
      .set({ approvedVersionNo: versionNo, version: sql`${contextItems.version} + 1` })
      .where(eq(contextItems.id, itemId));
    await audit(tx, actor, {
      action: 'artifact.approve',
      targetType: 'artifact',
      targetId: itemId,
      projectId: item.projectId,
      payload: { version: versionNo, sha256: v.sha256 },
    });
    await afterMutation(tx, project, item, 'artifact.approved', { version: versionNo, sha256: v.sha256 });
    return row!;
  });
  await syncContextMap(deps, project.id);
  return approved;
}

/** Artifacts of a project ordered by path; the cursor is the last path of the previous page. */
export async function listArtifacts(
  deps: Pick<ArtifactDeps, 'db'>,
  actor: Actor,
  projectId: string,
  opts: PageRequest = {},
): Promise<Page<ArtifactItem>> {
  await authorize(deps.db, actor, 'artifact.read', { projectId });
  if (opts.cursor !== undefined && (opts.cursor.length === 0 || opts.cursor.length > 500)) {
    throw new ValidationError('Invalid cursor');
  }
  const limit = clampLimit(opts.limit, 100, 200);
  const rows = await deps.db
    .select()
    .from(contextItems)
    .where(and(eq(contextItems.projectId, projectId), opts.cursor ? gt(contextItems.path, opts.cursor) : undefined))
    .orderBy(asc(contextItems.path))
    .limit(limit + 1);
  return toPage(rows, limit, (i) => i.path);
}

export async function getArtifact(deps: Pick<ArtifactDeps, 'db'>, actor: Actor, itemId: string) {
  const item = await loadItem(deps.db, itemId);
  await authorizeArtifactRead(deps.db, actor, item.projectId, item.path);
  return item;
}

export async function findArtifactByPath(
  db: Db,
  projectId: string,
  path: string,
): Promise<ArtifactItem | null> {
  const [i] = await db
    .select()
    .from(contextItems)
    .where(and(eq(contextItems.projectId, projectId), eq(contextItems.path, path)))
    .limit(1);
  return i ?? null;
}

export async function listArtifactVersions(deps: Pick<ArtifactDeps, 'db'>, actor: Actor, itemId: string) {
  const item = await loadItem(deps.db, itemId);
  await authorizeArtifactRead(deps.db, actor, item.projectId, item.path);
  return deps.db
    .select()
    .from(contextVersions)
    .where(eq(contextVersions.contextItemId, itemId))
    .orderBy(desc(contextVersions.versionNo));
}

/**
 * Internal (no authorization): loads a version's bytes from the blob store and verifies the SHA-256 against
 * the recorded hash. Callers must authorize first.
 */
export async function loadVersionContent(
  storage: StorageAdapter,
  project: Pick<Project, 'storagePath'>,
  version: Pick<ArtifactVersion, 'storageUri' | 'sha256' | 'contextItemId' | 'versionNo'>,
): Promise<Buffer> {
  const content = await blobStore(storage, project.storagePath).getBlob(version.storageUri);
  if (sha256Hex(content) !== version.sha256) {
    throw new IntegrityError(`Artifact ${version.contextItemId}@${version.versionNo} hash mismatch`);
  }
  return content;
}

/** Reads version content from the blob store and verifies it against the DB hash (tamper detection). */
export async function readArtifactVersion(
  deps: ArtifactDeps,
  actor: Actor,
  itemId: string,
  versionNo: number | 'latest' | 'approved',
): Promise<{ version: ArtifactVersion; content: Buffer }> {
  const item = await loadItem(deps.db, itemId);
  await authorizeArtifactRead(deps.db, actor, item.projectId, item.path);
  const project = await loadProject(deps.db, item.projectId);
  const no =
    versionNo === 'latest'
      ? item.currentVersionNo
      : versionNo === 'approved'
        ? item.approvedVersionNo
        : versionNo;
  if (no === null) throw new NotFoundError('Approved version of artifact', itemId);
  const [v] = await deps.db
    .select()
    .from(contextVersions)
    .where(and(eq(contextVersions.contextItemId, itemId), eq(contextVersions.versionNo, no)))
    .limit(1);
  if (!v) throw new NotFoundError('Artifact version', `${itemId}@${no}`);
  return { version: v, content: await loadVersionContent(deps.storage, project, v) };
}
