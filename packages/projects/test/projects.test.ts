import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type DatabaseConnection, projects as projectsTable, systemEvents } from '@platform/db';
import { bootstrapOwner, createUser } from '@platform/iam';
import { type Actor, ForbiddenError, NotFoundError } from '@platform/shared';
import { LocalStorage } from '@platform/storage';
import {
  AI_CONTEXT_DIRS,
  createAcceptanceCriterion,
  createProject,
  createRequirement,
  createUserStory,
  getProject,
  getProjectSettings,
  listProjects,
  listRequirements,
  type ProjectDeps,
  setProjectArchived,
  transitionRequirement,
  updateProject,
  updateProjectSettings,
  updateRequirement,
  upsertProjectMember,
} from '../src/index.js';

const PW = 'correct-horse-battery';
let conn: DatabaseConnection;
let dir: string;
let deps: ProjectDeps;
let owner: Actor;
let dev: Actor;
let devId: string;

beforeAll(async () => {
  conn = await createTestDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-test-'));
  deps = { db: conn.db, storage: new LocalStorage(dir) };
  const b = await bootstrapOwner(conn.db, { email: 'owner@example.com', password: PW, displayName: 'Owner' });
  owner = { type: 'user', userId: b.user.id, workspaceId: b.workspaceId };
  const d = await createUser(conn.db, owner, { email: 'dev@example.com', displayName: 'Dev', password: PW, role: 'developer' });
  devId = d.id;
  dev = { type: 'user', userId: d.id, workspaceId: b.workspaceId };
});
afterAll(async () => {
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('projects', () => {
  let projectId: string;

  it('creates a project with isolated workspace, .ai-context tree and git repo', async () => {
    const p = await createProject(deps, owner, { key: 'shop-api', name: 'Shop API', description: 'E-commerce backend' });
    projectId = p.id;
    const root = path.join(dir, p.storagePath);
    for (const d of AI_CONTEXT_DIRS) expect((await fs.stat(path.join(root, d))).isDirectory()).toBe(true);
    const manifest = JSON.parse(await fs.readFile(path.join(root, '.ai-context/00-index/project-manifest.json'), 'utf8'));
    expect(manifest.project_id).toBe(p.id);
    expect((await fs.stat(path.join(root, '.git'))).isDirectory()).toBe(true);
    const events = await conn.db.select().from(systemEvents);
    expect(events.map((e) => e.type)).toContain('project.created');
  });

  it('rejects duplicate keys and invalid keys, rolling back filesystem', async () => {
    await expect(createProject(deps, owner, { key: 'shop-api', name: 'Dup' })).rejects.toMatchObject({ code: 'project_key_taken' });
    await expect(createProject(deps, owner, { key: 'Bad Key!', name: 'X' })).rejects.toMatchObject({ code: 'validation_error' });
    expect(await conn.db.select().from(projectsTable)).toHaveLength(1);
  });

  it('developers cannot create projects and cannot see projects they are not members of', async () => {
    await expect(createProject(deps, dev, { key: 'nope', name: 'Nope' })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await listProjects(deps, dev)).toHaveLength(0);
    await expect(getProject(deps, dev, projectId)).rejects.toBeInstanceOf(NotFoundError);
    await upsertProjectMember(deps, owner, projectId, { userId: devId, role: 'developer' });
    expect(await listProjects(deps, dev)).toHaveLength(1);
    await expect(updateProject(deps, dev, projectId, { name: 'Hacked', expectedVersion: 1 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('uses optimistic concurrency on updates', async () => {
    const p = await updateProject(deps, owner, projectId, { name: 'Shop API v2', expectedVersion: 1 });
    expect(p.version).toBe(2);
    await expect(updateProject(deps, owner, projectId, { name: 'stale', expectedVersion: 1 })).rejects.toMatchObject({
      code: 'version_conflict',
    });
    const s = await getProjectSettings(deps, owner, projectId);
    const s2 = await updateProjectSettings(deps, owner, projectId, { settings: { runtime: 'node' }, expectedVersion: s.version });
    expect(s2.configVersion).toBe(2);
  });

  it('archives non-destructively and filters by status', async () => {
    await setProjectArchived(deps, owner, projectId, true);
    expect(await listProjects(deps, owner, { status: 'active' })).toHaveLength(0);
    expect(await listProjects(deps, owner, { status: 'archived' })).toHaveLength(1);
    await setProjectArchived(deps, owner, projectId, false);
  });

  it('isolates projects across workspaces', async () => {
    const foreign: Actor = { type: 'user', userId: devId, workspaceId: '00000000-0000-7000-8000-000000000000' };
    await expect(getProject(deps, foreign, projectId)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('requirements, stories, acceptance criteria', () => {
  let projectId: string;
  beforeAll(async () => {
    projectId = (await createProject(deps, owner, { key: 'req-proj', name: 'Req' })).id;
    await upsertProjectMember(deps, owner, projectId, { userId: devId, role: 'developer' });
  });

  it('auto-codes and enforces lifecycle + approval permission', async () => {
    const r = await createRequirement(conn.db, dev, projectId, { title: 'User login', body: 'Users log in with email' });
    expect(r.code).toBe('REQ-001');
    const r2 = await transitionRequirement(conn.db, dev, r.id, 'in_review', r.version);
    // developers may not approve
    await expect(transitionRequirement(conn.db, dev, r.id, 'approved', r2.version)).rejects.toBeInstanceOf(ForbiddenError);
    const r3 = await transitionRequirement(conn.db, owner, r.id, 'approved', r2.version);
    expect(r3.status).toBe('approved');
    // approved requirements are immutable
    await expect(updateRequirement(conn.db, owner, r.id, { title: 'changed', expectedVersion: r3.version })).rejects.toMatchObject({
      code: 'approved_immutable',
    });
    await expect(transitionRequirement(conn.db, owner, r.id, 'draft', r3.version)).rejects.toMatchObject({
      code: 'invalid_state_transition',
    });
    expect(await listRequirements(conn.db, dev, projectId)).toHaveLength(1);
  });

  it('creates stories with acceptance criteria', async () => {
    const s = await createUserStory(conn.db, dev, projectId, { asA: 'shopper', iWant: 'to log in', soThat: 'I can order', priority: 'must' });
    expect(s.code).toBe('US-001');
    const ac = await createAcceptanceCriterion(conn.db, dev, s.id, { given: 'valid credentials', when: 'I submit', then: 'I am logged in' });
    expect(ac.code).toBe('US-001-AC1');
    await expect(createAcceptanceCriterion(conn.db, dev, s.id, { then: '' })).rejects.toMatchObject({ code: 'validation_error' });
  });
});
