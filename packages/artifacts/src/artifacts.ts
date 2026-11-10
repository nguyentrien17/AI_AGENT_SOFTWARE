import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { contextItems, contextVersions, type Db, isUniqueViolation, projects } from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import {
  type Actor,
  actorId,
  ConflictError,
  NotFoundError,
  sha256Hex,
  ValidationError,
  VersionConflictError,
} from '@platform/shared';
import { IntegrityError, type StorageAdapter } from '@platform/storage';

export interface ArtifactDeps {
  db: Db;
  storage: StorageAdapter;
}

export type ArtifactItem = typeof contextItems.$inferSelect;
export type ArtifactVersion = typeof contextVersions.$inferSelect;

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
  if (norm.startsWith('.ai-context/00-index/') || norm.endsWith('/.gitkeep')) {
    throw new ValidationError('Index files are managed by the platform', [
      { path: 'path', message: 'reserved' },
    ]);
  }
  return norm;
}

async function loadProject(db: Db, projectId: string) {
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

function blobStore(deps: ArtifactDeps, storagePath: string): StorageAdapter {
  return deps.storage.scoped(storagePath).scoped('artifacts');
}

async function writeWorkingCopy(deps: ArtifactDeps, storagePath: string, path: string, buf: Buffer) {
  await deps.storage.scoped(storagePath).writeAtomic(path, buf);
}

export async function createArtifact(
  deps: ArtifactDeps,
  actor: Actor,
  projectId: string,
  input: { path: string; type: string; content: string | Buffer; ownerRole?: string; changeNote?: string },
): Promise<{ item: ArtifactItem; version: ArtifactVersion }> {
  await authorize(deps.db, actor, 'artifact.write', { projectId });
  const project = await loadProject(deps.db, projectId);
  const path = normalizeArtifactPath(input.path);
  const type = input.type.trim();
  if (!type) throw new ValidationError('Artifact type is required');
  const buf = toBuffer(input.content);
  const blob = await blobStore(deps, project.storagePath).putBlob(buf);

  let result: { item: ArtifactItem; version: ArtifactVersion };
  try {
    result = await deps.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [item] = await tx
        .insert(contextItems)
        .values({ projectId, path, type, ownerRole: input.ownerRole ?? null, currentVersionNo: 1 })
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
      await emitEvent(tx, {
        type: 'artifact.created',
        aggregateType: 'artifact',
        aggregateId: item!.id,
        workspaceId: project.workspaceId,
        projectId,
        payload: { path, version: 1, sha256: blob.sha256 },
      });
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
  await writeWorkingCopy(deps, project.storagePath, path, buf);
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
  await authorize(deps.db, actor, 'artifact.write', { projectId: item.projectId });
  const project = await loadProject(deps.db, item.projectId);
  const buf = toBuffer(input.content);
  const blob = await blobStore(deps, project.storagePath).putBlob(buf);
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
      await emitEvent(tx, {
        type: 'artifact.versioned',
        aggregateType: 'artifact',
        aggregateId: itemId,
        workspaceId: project.workspaceId,
        projectId: item.projectId,
        payload: { path: item.path, version: nextNo, sha256: blob.sha256 },
      });
      return { item: updated, version: version! };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const cur = await loadItem(deps.db, itemId);
      throw new VersionConflictError('Artifact', input.expectedVersionNo, cur.currentVersionNo);
    }
    throw e;
  }
  await writeWorkingCopy(deps, project.storagePath, item.path, buf);
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
  await authorize(deps.db, actor, 'artifact.approve', { projectId: head.projectId });
  if (actor.type !== 'user') throw new ValidationError('Only human users can approve artifacts');
  return deps.db.transaction(async (txRaw) => {
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
    const [approved] = await tx
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
    await emitEvent(tx, {
      type: 'artifact.approved',
      aggregateType: 'artifact',
      aggregateId: itemId,
      workspaceId: actor.workspaceId,
      projectId: item.projectId,
      payload: { path: item.path, version: versionNo, sha256: v.sha256 },
    });
    return approved!;
  });
}

export async function listArtifacts(deps: Pick<ArtifactDeps, 'db'>, actor: Actor, projectId: string) {
  await authorize(deps.db, actor, 'artifact.read', { projectId });
  return deps.db
    .select()
    .from(contextItems)
    .where(eq(contextItems.projectId, projectId))
    .orderBy(asc(contextItems.path));
}

export async function getArtifact(deps: Pick<ArtifactDeps, 'db'>, actor: Actor, itemId: string) {
  const item = await loadItem(deps.db, itemId);
  await authorize(deps.db, actor, 'artifact.read', { projectId: item.projectId });
  return item;
}

export async function listArtifactVersions(deps: Pick<ArtifactDeps, 'db'>, actor: Actor, itemId: string) {
  const item = await loadItem(deps.db, itemId);
  await authorize(deps.db, actor, 'artifact.read', { projectId: item.projectId });
  return deps.db
    .select()
    .from(contextVersions)
    .where(eq(contextVersions.contextItemId, itemId))
    .orderBy(desc(contextVersions.versionNo));
}

/** Reads version content from the blob store and verifies it against the DB hash (tamper detection). */
export async function readArtifactVersion(
  deps: ArtifactDeps,
  actor: Actor,
  itemId: string,
  versionNo: number | 'latest' | 'approved',
): Promise<{ version: ArtifactVersion; content: Buffer }> {
  const item = await loadItem(deps.db, itemId);
  await authorize(deps.db, actor, 'artifact.read', { projectId: item.projectId });
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
  const content = await blobStore(deps, project.storagePath).getBlob(v.storageUri);
  if (sha256Hex(content) !== v.sha256) throw new IntegrityError(`Artifact ${itemId}@${no} hash mismatch`);
  return { version: v, content };
}
