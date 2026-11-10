import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approveArtifactVersion, createArtifact, createArtifactVersion } from '@platform/artifacts';
import { contextPackages, createTestDatabase, type DatabaseConnection, systemEvents } from '@platform/db';
import { bootstrapOwner } from '@platform/iam';
import { addDependency, createTask, recordGateEvaluation, transitionTask } from '@platform/orchestration';
import { createProject } from '@platform/projects';
import { type Actor, ForbiddenError, uuidv7 } from '@platform/shared';
import { LocalStorage } from '@platform/storage';
import {
  addProjectMemory,
  buildContextPackage,
  createCheckpoint,
  getProjectContextIndex,
  loadContextPackage,
  renderUntrustedContext,
  submitHandoff,
  verifyCheckpoint,
} from '../src/index.js';

/**
 * Phase 2 Gate (docs/phase-0/08-roadmap.md): simulated Agent A writes versioned output → Context Manager builds
 * a package → simulated Agent B consumes it without any chat transcript → mutating the source artifact
 * invalidates the cache. Plus hash verification, permissions, budget, checkpoints.
 */
const PW = 'correct-horse-battery';
let conn: DatabaseConnection;
let dir: string;
let storage: LocalStorage;
let owner: Actor;
let system: Actor;
let projectId: string;
let projectRoot: string;
let t1: string;
let t2: string;
let ba: Actor;
let architect: Actor;
let deps: { db: DatabaseConnection['db']; storage: LocalStorage };

const evidence = {
  tool: 'test',
  toolVersion: '1',
  command: 'n/a',
  environmentId: 'test',
  gitTreeHash: null,
  logUri: null,
};

beforeAll(async () => {
  conn = await createTestDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-test-'));
  storage = new LocalStorage(dir);
  deps = { db: conn.db, storage };
  const b = await bootstrapOwner(conn.db, { email: 'owner@example.com', password: PW, displayName: 'Owner' });
  owner = { type: 'user', userId: b.user.id, workspaceId: b.workspaceId };
  system = { type: 'system', workspaceId: b.workspaceId, component: 'test-orchestrator' };
  const p = await createProject(deps, owner, { key: 'ctx', name: 'Context Project' });
  projectId = p.id;
  projectRoot = path.join(dir, p.storagePath);

  t1 = (
    await createTask(conn.db, owner, projectId, {
      title: 'Analyse requirements',
      objective: 'Write requirements',
      agentRole: 'ba',
    })
  ).id;
  t2 = (
    await createTask(conn.db, owner, projectId, {
      title: 'Design architecture',
      objective: 'Design the system',
      agentRole: 'architect',
      tokenCeiling: 5000,
    })
  ).id;
  await addDependency(conn.db, owner, t2, t1);
  await transitionTask(conn.db, owner, t1, 'pending');
  await transitionTask(conn.db, owner, t2, 'pending');
  await transitionTask(conn.db, system, t1, 'assigned');
  await transitionTask(conn.db, system, t1, 'running');
  ba = { type: 'agent', agentKey: 'ba', agentVersion: 1, workspaceId: b.workspaceId, taskId: t1 };
  architect = {
    type: 'agent',
    agentKey: 'architect',
    agentVersion: 1,
    workspaceId: b.workspaceId,
    taskId: t2,
  };
});
afterAll(async () => {
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Phase 2 gate — shared project context', () => {
  let overviewId: string;
  let overviewV1Sha: string;
  let acSha: string;
  let packageId: string;

  it('Agent A (BA) writes versioned outputs only in its own area', async () => {
    const o = await createArtifact(deps, ba, projectId, {
      path: '.ai-context/01-requirements/overview.md',
      type: 'requirement',
      content: '# Overview\nAn online shop.',
    });
    overviewId = o.item.id;
    overviewV1Sha = o.version.sha256;
    expect(o.item.ownerRole).toBe('ba');
    const ac = await createArtifact(deps, ba, projectId, {
      path: '.ai-context/01-requirements/acceptance-criteria.md',
      type: 'requirement',
      content: '- Checkout works',
    });
    acSha = ac.version.sha256;
    await expect(
      createArtifact(deps, ba, projectId, {
        path: '.ai-context/02-architecture/system-architecture.md',
        type: 'architecture',
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // an agent not bound to an active task cannot write at all
    await expect(
      createArtifact(deps, architect, projectId, {
        path: '.ai-context/02-architecture/x.md',
        type: 'architecture',
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // humans cannot write agent-owned architecture
    await expect(
      createArtifact(deps, owner, projectId, {
        path: '.ai-context/02-architecture/x.md',
        type: 'architecture',
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const map = JSON.parse(
      await fs.readFile(path.join(projectRoot, '.ai-context/00-index/context-map.json'), 'utf8'),
    );
    expect(map.items.map((i: { path: string }) => i.path)).toEqual([
      '.ai-context/01-requirements/acceptance-criteria.md',
      '.ai-context/01-requirements/overview.md',
    ]);
  });

  it('Agent A emits a schema-validated handoff whose refs must match persisted hashes', async () => {
    const handoff = {
      schema_version: '1.0' as const,
      handoff_id: uuidv7(),
      project_id: projectId,
      task_id: t1,
      from_agent: 'ba',
      to_agent: 'architect',
      status: 'completed' as const,
      output_refs: [
        { path: '.ai-context/01-requirements/overview.md', version: 1, sha256: overviewV1Sha },
        { path: '.ai-context/01-requirements/acceptance-criteria.md', version: 1, sha256: acSha },
      ],
      decisions: ['Single-tenant shop'],
      assumptions: [],
      open_questions: [],
      required_actions: ['Design system architecture and module boundaries'],
      created_at: new Date().toISOString(),
    };
    await expect(
      submitHandoff(deps, ba, {
        ...handoff,
        handoff_id: uuidv7(),
        output_refs: [{ ...handoff.output_refs[0]!, sha256: 'b'.repeat(64) }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      submitHandoff(deps, ba, { ...handoff, handoff_id: uuidv7(), from_agent: 'architect' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submitHandoff(deps, owner, handoff)).rejects.toBeInstanceOf(ForbiddenError);
    const row = await submitHandoff(deps, ba, handoff);
    expect(row.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(submitHandoff(deps, ba, handoff)).rejects.toMatchObject({ code: 'handoff_exists' });

    await recordGateEvaluation(conn.db, system, t1, {
      gateKey: 'requirements-review',
      outcome: 'passed',
      evidence,
    });
    await transitionTask(conn.db, system, t1, 'completed');
    await transitionTask(conn.db, system, t2, 'assigned');
    await transitionTask(conn.db, system, t2, 'running');
  });

  it('Context Manager builds a deterministic, deduplicated, hash-pinned package for Agent B', async () => {
    const r = await buildContextPackage(deps, architect, { taskId: t2 });
    expect(r.cacheHit).toBe(false);
    packageId = r.packageId;
    const m = r.manifest;
    expect(m.agent_role).toBe('architect');
    expect(m.dependencies).toEqual([t1]);
    // overview.md appears via handoff AND role default → deduplicated, handoff source wins
    expect(m.items.map((i) => [i.path, i.source, i.version])).toEqual([
      ['.ai-context/01-requirements/acceptance-criteria.md', 'handoff', 1],
      ['.ai-context/01-requirements/overview.md', 'handoff', 1],
    ]);
    expect(m.items.every((i) => /^[0-9a-f]{64}$/.test(i.hash))).toBe(true);
    expect(m.excluded).toContainEqual({ path: '.ai-context/08-knowledge/glossary.md', reason: 'not_found' });
    expect(m.estimated_tokens).toBeGreaterThan(0);
    expect(m.token_budget).toBe(5000);

    const again = await buildContextPackage(deps, architect, { taskId: t2 });
    expect(again).toMatchObject({ cacheHit: true, packageId });
    // agents cannot build packages for other roles
    await expect(
      buildContextPackage(deps, architect, { taskId: t2, agentRole: 'developer' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('Agent B consumes the package without any chat transcript', async () => {
    const loaded = await loadContextPackage(deps, architect, packageId);
    expect(loaded.items.find((i) => i.path.endsWith('overview.md'))!.content).toBe(
      '# Overview\nAn online shop.',
    );
    const prompt = renderUntrustedContext(loaded);
    expect(prompt).toContain(`sha256="${overviewV1Sha}"`);
    expect(prompt).toContain('[UNTRUSTED_CONTEXT');
    // the BA agent cannot load the architect's package
    await expect(loadContextPackage(deps, ba, packageId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('mutating a source artifact invalidates the cached package immediately', async () => {
    await createArtifactVersion(deps, owner, overviewId, {
      content: '# Overview v2\nAn online shop with B2B.',
      expectedVersionNo: 1,
    });
    const [pkg] = await conn.db.select().from(contextPackages).where(eq(contextPackages.id, packageId));
    expect(pkg!.invalidatedAt).not.toBeNull();
    expect(pkg!.invalidationReason).toContain('artifact.versioned');
    await expect(loadContextPackage(deps, architect, packageId)).rejects.toMatchObject({
      code: 'context_package_stale',
    });

    // Draft v2 is not approved → the rebuilt package still pins the handoff's v1.
    const rebuilt = await buildContextPackage(deps, architect, { taskId: t2 });
    expect(rebuilt.cacheHit).toBe(false);
    expect(rebuilt.packageId).not.toBe(packageId);
    expect(rebuilt.manifest.items.find((i) => i.path.endsWith('overview.md'))!.version).toBe(1);

    // Human approval of v2 invalidates again; the next build picks the approved, newer version.
    await approveArtifactVersion(deps, owner, overviewId, 2);
    await expect(loadContextPackage(deps, architect, rebuilt.packageId)).rejects.toMatchObject({
      code: 'context_package_stale',
    });
    const latest = await buildContextPackage(deps, architect, { taskId: t2 });
    const ov = latest.manifest.items.find((i) => i.path.endsWith('overview.md'))!;
    expect(ov.version).toBe(2);
    expect(ov.note).toBe('supersedes handoff v1');
    const loaded = await loadContextPackage(deps, architect, latest.packageId);
    expect(loaded.items.find((i) => i.path.endsWith('overview.md'))!.content).toContain('B2B');

    const events = (await conn.db.select().from(systemEvents)).map((e) => e.type);
    expect(events).toEqual(
      expect.arrayContaining([
        'artifact.created',
        'artifact.versioned',
        'context.updated',
        'handoff.created',
      ]),
    );
  });

  it('project constraints are injected and invalidate packages', async () => {
    const before = await buildContextPackage(deps, architect, { taskId: t2 });
    await addProjectMemory(conn.db, owner, projectId, {
      kind: 'constraint',
      content: 'All data must stay in the EU.',
    });
    await expect(loadContextPackage(deps, architect, before.packageId)).rejects.toMatchObject({
      code: 'context_package_stale',
    });
    const after = await buildContextPackage(deps, architect, { taskId: t2 });
    expect(after.manifest.constraints.map((c) => c.content)).toEqual(['All data must stay in the EU.']);
    const loaded = await loadContextPackage(deps, architect, after.packageId);
    expect(renderUntrustedContext(loaded)).toContain('kind="project-constraints"');
  });

  it('enforces the token budget instead of silently dropping required context', async () => {
    await expect(buildContextPackage(deps, architect, { taskId: t2, tokenBudget: 5 })).rejects.toMatchObject({
      code: 'context_budget_exceeded',
    });
  });

  it('detects tampering of stored content at consumption time', async () => {
    const pkg = await buildContextPackage(deps, architect, { taskId: t2 });
    const item = pkg.manifest.items[0]!;
    await fs.writeFile(
      path.join(projectRoot, 'artifacts/.blobs', item.hash.slice(0, 2), item.hash),
      'tampered',
    );
    await expect(loadContextPackage(deps, architect, pkg.packageId)).rejects.toMatchObject({
      code: 'integrity_error',
    });
    // restore for the following tests
    const original = item.path.endsWith('acceptance-criteria.md')
      ? '- Checkout works'
      : '# Overview v2\nAn online shop with B2B.';
    await fs.writeFile(
      path.join(projectRoot, 'artifacts/.blobs', item.hash.slice(0, 2), item.hash),
      original,
    );
  });

  it('checkpoints snapshot artifacts + tasks, commit to git and verify integrity', async () => {
    const cp = await createCheckpoint(deps, owner, projectId, { label: 'after design start', taskId: t2 });
    expect(cp.gitCommit).toMatch(/^[0-9a-f]{40}$/);
    const state = cp.state as {
      artifacts: Array<{ path: string }>;
      tasks: Array<{ id: string; status: string }>;
    };
    expect(state.tasks).toContainEqual(expect.objectContaining({ id: t1, status: 'completed' }));
    expect(state.artifacts.some((a) => a.path.endsWith('overview.md'))).toBe(true);
    expect((await verifyCheckpoint(deps, owner, cp.id)).verification).toEqual({ valid: true, problems: [] });
    await expect(createCheckpoint(deps, architect, projectId, { label: 'x' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const idx = await getProjectContextIndex(conn.db, owner, projectId);
    expect(idx.contextVersion).toBeGreaterThan(3);
    const sha = state.artifacts.find((a) => a.path.endsWith('acceptance-criteria.md')) as unknown as {
      current_sha256: string;
    };
    await fs.writeFile(
      path.join(projectRoot, 'artifacts/.blobs', sha.current_sha256.slice(0, 2), sha.current_sha256),
      'evil',
    );
    const v = await verifyCheckpoint(deps, owner, cp.id);
    expect(v.verification.valid).toBe(false);
    expect(v.verification.problems[0]!.path).toContain('acceptance-criteria.md');
  });
});
