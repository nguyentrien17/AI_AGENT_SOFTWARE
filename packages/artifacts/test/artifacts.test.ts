import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type DatabaseConnection, systemEvents } from '@platform/db';
import { bootstrapOwner, createUser } from '@platform/iam';
import { createProject, upsertProjectMember } from '@platform/projects';
import { type Actor, ForbiddenError } from '@platform/shared';
import { LocalStorage } from '@platform/storage';
import {
  approveArtifactVersion,
  createArtifact,
  createArtifactVersion,
  listArtifactVersions,
  normalizeArtifactPath,
  readArtifactVersion,
} from '../src/index.js';

const PW = 'correct-horse-battery';
let conn: DatabaseConnection;
let dir: string;
let storage: LocalStorage;
let owner: Actor;
let dev: Actor;
let viewer: Actor;
let projectId: string;
let projectRoot: string;

beforeAll(async () => {
  conn = await createTestDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artifacts-test-'));
  storage = new LocalStorage(dir);
  const b = await bootstrapOwner(conn.db, { email: 'owner@example.com', password: PW, displayName: 'Owner' });
  owner = { type: 'user', userId: b.user.id, workspaceId: b.workspaceId };
  const d = await createUser(conn.db, owner, {
    email: 'dev@example.com',
    displayName: 'Dev',
    password: PW,
    role: 'developer',
  });
  const v = await createUser(conn.db, owner, {
    email: 'view@example.com',
    displayName: 'V',
    password: PW,
    role: 'viewer',
  });
  dev = { type: 'user', userId: d.id, workspaceId: b.workspaceId };
  viewer = { type: 'user', userId: v.id, workspaceId: b.workspaceId };
  const p = await createProject({ db: conn.db, storage }, owner, { key: 'art', name: 'Artifacts' });
  projectId = p.id;
  projectRoot = path.join(dir, p.storagePath);
  await upsertProjectMember({ db: conn.db }, owner, projectId, { userId: d.id, role: 'developer' });
  await upsertProjectMember({ db: conn.db }, owner, projectId, { userId: v.id, role: 'viewer' });
});
afterAll(async () => {
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('artifact path rules', () => {
  it.each([
    '../x.md',
    '/abs.md',
    'source-code/a.ts',
    '.ai-context/00-index/project-manifest.json',
    '.ai-context/./a.md',
    'C:/x.md',
  ])('rejects %s', (p) => expect(() => normalizeArtifactPath(p)).toThrow());
  it('accepts curated roots', () => {
    expect(normalizeArtifactPath('.ai-context\\01-requirements\\overview.md')).toBe(
      '.ai-context/01-requirements/overview.md',
    );
  });
});

describe('versioned artifact persistence', () => {
  const PATH = '.ai-context/01-requirements/overview.md';
  let itemId: string;

  it('creates v1 with sha256, blob and working copy', async () => {
    const { item, version } = await createArtifact({ db: conn.db, storage }, dev, projectId, {
      path: PATH,
      type: 'requirement',
      content: '# Overview v1',
    });
    itemId = item.id;
    expect(version.versionNo).toBe(1);
    expect(version.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.readFile(path.join(projectRoot, PATH), 'utf8')).toBe('# Overview v1');
    await expect(
      createArtifact({ db: conn.db, storage }, dev, projectId, {
        path: PATH,
        type: 'requirement',
        content: 'dup',
      }),
    ).rejects.toMatchObject({ code: 'artifact_exists' });
  });

  it('enforces optimistic concurrency on new versions', async () => {
    const r = await createArtifactVersion({ db: conn.db, storage }, dev, itemId, {
      content: '# Overview v2',
      expectedVersionNo: 1,
    });
    expect(r.version.versionNo).toBe(2);
    await expect(
      createArtifactVersion({ db: conn.db, storage }, dev, itemId, {
        content: 'stale',
        expectedVersionNo: 1,
      }),
    ).rejects.toMatchObject({ code: 'version_conflict', extensions: { expected: 1, actual: 2 } });
  });

  it('only authorized humans approve; approved versions are immutable and superseded by later approvals', async () => {
    await expect(approveArtifactVersion({ db: conn.db, storage }, dev, itemId, 2)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await approveArtifactVersion({ db: conn.db, storage }, owner, itemId, 1);
    await approveArtifactVersion({ db: conn.db, storage }, owner, itemId, 2);
    const versions = await listArtifactVersions({ db: conn.db }, viewer, itemId);
    expect(versions.map((v) => [v.versionNo, v.status])).toEqual([
      [2, 'approved'],
      [1, 'superseded'],
    ]);
    await expect(approveArtifactVersion({ db: conn.db, storage }, owner, itemId, 1)).rejects.toMatchObject({
      code: 'version_superseded',
    });

    const approved = await readArtifactVersion({ db: conn.db, storage }, viewer, itemId, 'approved');
    expect(approved.content.toString()).toBe('# Overview v2');
    const v1 = await readArtifactVersion({ db: conn.db, storage }, viewer, itemId, 1);
    expect(v1.content.toString()).toBe('# Overview v1');
  });

  it('viewers cannot write', async () => {
    await expect(
      createArtifactVersion({ db: conn.db, storage }, viewer, itemId, { content: 'x', expectedVersionNo: 2 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('detects tampering of stored blobs', async () => {
    const { version } = await readArtifactVersion({ db: conn.db, storage }, owner, itemId, 2);
    const sha = version.sha256;
    await fs.writeFile(path.join(projectRoot, 'artifacts/.blobs', sha.slice(0, 2), sha), 'evil');
    await expect(readArtifactVersion({ db: conn.db, storage }, owner, itemId, 2)).rejects.toMatchObject({
      code: 'integrity_error',
    });
  });

  it('emits artifact domain events', async () => {
    const types = (await conn.db.select().from(systemEvents)).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['artifact.created', 'artifact.versioned', 'artifact.approved']),
    );
  });
});
