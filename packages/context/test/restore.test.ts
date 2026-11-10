import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createArtifact, createArtifactVersion, listArtifactVersions, readArtifactVersion } from '@platform/artifacts';
import { createTestDatabase, type DatabaseConnection } from '@platform/db';
import { bootstrapOwner } from '@platform/iam';
import { createProject } from '@platform/projects';
import type { Actor } from '@platform/shared';
import { LocalStorage } from '@platform/storage';
import { runGit } from '@platform/tool-executor';
import { createCheckpoint, restoreCheckpoint } from '../src/index.js';

/** R9: restoring a checkpoint brings content back without deleting any history. */
let conn: DatabaseConnection;
let dir: string;
let deps: { db: DatabaseConnection['db']; storage: LocalStorage };
let owner: Actor;

beforeAll(async () => {
  conn = await createTestDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-'));
  deps = { db: conn.db, storage: new LocalStorage(dir) };
  const b = await bootstrapOwner(conn.db, { email: 'o@example.com', password: 'correct-horse-battery', displayName: 'O' });
  owner = { type: 'user', userId: b.user.id, workspaceId: b.workspaceId };
});

afterAll(async () => {
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('checkpoint restore (R9)', () => {
  it('restores changed artifacts as new versions, reports later additions, and exposes the code on a branch', async () => {
    const project = await createProject({ ...deps, initGit: true }, owner, { key: 'restore', name: 'Restore' });
    const { item } = await createArtifact(deps, owner, project.id, {
      path: '.ai-context/08-knowledge/glossary.md',
      type: 'glossary',
      content: '# Glossary\nTodo: a thing to do.\n',
    });
    const cp = await createCheckpoint(deps, owner, project.id, { label: 'before redesign' });
    expect(cp.gitCommit).toMatch(/^[0-9a-f]{40}$/);

    await createArtifactVersion(deps, owner, item.id, { content: '# Glossary\nTodo: REWRITTEN BADLY.\n', expectedVersionNo: 1 });
    await createArtifact(deps, owner, project.id, { path: '.ai-context/08-knowledge/later.md', type: 'note', content: 'added later' });

    const agent: Actor = { type: 'agent', agentKey: 'architect', agentVersion: 1, workspaceId: owner.workspaceId! };
    await expect(restoreCheckpoint(deps, agent, cp.id)).rejects.toThrow(/Only a human/);

    const report = await restoreCheckpoint(deps, owner, cp.id);
    expect(report.restored).toEqual([
      { path: '.ai-context/08-knowledge/glossary.md', checkpointVersion: 1, previousVersion: 2, newVersion: 3 },
    ]);
    expect(report.addedSince).toEqual(['.ai-context/08-knowledge/later.md']);
    expect(report.gitBranch).toBe(`restore/${cp.id}`);

    // Content is back; history is intact (v1, v2 and the restoring v3 all exist).
    const { content } = await readArtifactVersion(deps, owner, item.id, 'latest');
    expect(content.toString('utf8')).toBe('# Glossary\nTodo: a thing to do.\n');
    expect((await listArtifactVersions(deps, owner, item.id)).map((v) => v.versionNo).sort()).toEqual([1, 2, 3]);

    const repo = path.join(dir, project.storagePath);
    const branchHead = (await runGit(repo, ['rev-parse', `restore/${cp.id}`])).stdout.trim();
    expect(branchHead).toBe(cp.gitCommit);

    // Restoring twice is harmless: nothing differs any more, the branch already exists.
    const again = await restoreCheckpoint(deps, owner, cp.id);
    expect(again).toMatchObject({ restored: [], unchanged: 1, gitBranch: `restore/${cp.id}` });
  });
});
