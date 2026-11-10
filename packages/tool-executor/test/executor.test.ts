import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  agents,
  agentVersions,
  auditLogs,
  createTestDatabase,
  type DatabaseConnection,
  taskAssignments,
  taskExecutions,
  taskLeases,
  tasks,
  toolExecutions,
  toolPermissions,
  toolRegistry,
  workspaces,
} from '@platform/db';
import { bootstrapOwner } from '@platform/iam';
import { createProject } from '@platform/projects';
import { type Actor, uuidv7 } from '@platform/shared';
import { LocalStorage } from '@platform/storage';
import {
  createDefaultToolCatalog,
  DestructiveGitError,
  executeTool,
  removeTaskWorktree,
  runGit,
  syncToolRegistry,
  taskWorktreeDir,
  type ToolExecutorDeps,
} from '../src/index.js';

/** Phase 6 part A: tool executor against a real git repository (no container needed). */
let conn: DatabaseConnection;
let root: string;
let outside: string;
let deps: ToolExecutorDeps;
let workspaceId: string;
let projectId: string;
let projectKey: string;
let repoDir: string;
let agentId: string;
let versionId: string;
let clock: Date;

const DEV_SCOPES = ['source-code/**', 'tests/**'];

async function newRunningTask(opts: { allowedTools?: string[]; leaseSeconds?: number } = {}) {
  const [task] = await conn.db
    .insert(tasks)
    .values({
      projectId,
      title: 'Implement',
      objective: 'Write code',
      agentRole: 'developer',
      status: 'running',
      allowedTools: opts.allowedTools ?? [],
      createdBy: 'test',
    })
    .returning();
  const [exec] = await conn.db
    .insert(taskExecutions)
    .values({ taskId: task!.id, attemptNo: 1, workerId: 'w', agentVersionId: versionId, startedAt: clock })
    .returning();
  await conn.db.insert(taskLeases).values({
    taskId: task!.id,
    executionId: exec!.id,
    holder: 'w',
    expiresAt: new Date(clock.getTime() + (opts.leaseSeconds ?? 600) * 1000),
    heartbeatAt: clock,
  });
  await conn.db.insert(taskAssignments).values({ taskId: task!.id, agentId, agentVersionId: versionId, assignedBy: 'test' });
  const actor: Actor = { type: 'agent', agentKey: 'developer', agentVersion: 1, workspaceId, taskId: task!.id };
  return { task: task!, executionId: exec!.id, actor };
}

beforeAll(async () => {
  conn = await createTestDatabase();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-exec-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-outside-'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET');
  const storage = new LocalStorage(root);
  const b = await bootstrapOwner(conn.db, { email: 'o@example.com', password: 'correct-horse-battery', displayName: 'O' });
  workspaceId = b.workspaceId;
  const owner: Actor = { type: 'user', userId: b.user.id, workspaceId };
  const project = await createProject({ db: conn.db, storage, initGit: true }, owner, { key: 'tools', name: 'Tools' });
  projectId = project.id;
  projectKey = project.key;
  repoDir = path.join(root, project.storagePath);
  await fs.writeFile(path.join(repoDir, 'source-code', 'app.ts'), 'export const v = 1;\n');
  await runGit(repoDir, ['add', '--all']);
  await runGit(repoDir, ['commit', '-q', '-m', 'seed app']);

  const [agent] = await conn.db
    .insert(agents)
    .values({ workspaceId, agentKey: 'developer', name: 'Developer', role: 'developer' })
    .returning();
  const [version] = await conn.db
    .insert(agentVersions)
    .values({
      agentId: agent!.id,
      versionNo: 1,
      systemInstruction: 'Write code.',
      allowedTools: ['fs_read_file', 'fs_list_dir', 'fs_write_file', 'fs_delete_file', 'git_status', 'git_diff', 'git_commit', 'git_log', 'git_check_merge'],
      allowedActions: ['read_file', 'write_file', 'delete_file', 'git_read', 'git_commit'],
      allowedFileScopes: DEV_SCOPES,
      contentHash: 'x',
      createdBy: 'test',
    })
    .returning();
  await conn.db.update(agents).set({ currentVersionId: version!.id }).where(eq(agents.id, agent!.id));
  agentId = agent!.id;
  versionId = version!.id;

  clock = new Date();
  deps = { db: conn.db, storageRoot: root, catalog: createDefaultToolCatalog(), now: () => clock };
  expect(await syncToolRegistry(conn.db, deps.catalog)).toBe(9);
});

afterAll(async () => {
  await conn.close();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

beforeEach(() => {
  clock = new Date();
});

describe('tool executor (P6-01…P6-05) [integration]', () => {
  it('publishes the catalog to tool_registry idempotently', async () => {
    const before = await conn.db.select().from(toolRegistry);
    await syncToolRegistry(conn.db, deps.catalog);
    const after = await conn.db.select().from(toolRegistry);
    expect(after.map((r) => [r.toolKey, r.updatedAt.getTime()])).toEqual(before.map((r) => [r.toolKey, r.updatedAt.getTime()]));
    expect(after.find((r) => r.toolKey === 'fs_write_file')).toMatchObject({ risk: 'medium', action: 'write_file', idempotent: true });
  });

  it('works in an isolated worktree on branch task/{id}: write, read, list, diff, commit, merge check', async () => {
    const { task, actor, executionId } = await newRunningTask();
    const run = (toolKey: string, input: unknown) => executeTool(deps, actor, { toolKey, input, taskExecutionId: executionId });

    const written = await run('fs_write_file', { path: 'source-code/feature.ts', content: 'export const f = () => 42;\n' });
    expect(written).toMatchObject({ status: 'succeeded', output: { path: 'source-code/feature.ts', created: true } });
    expect((await run('fs_read_file', { path: 'source-code/app.ts' })).output).toMatchObject({ content: 'export const v = 1;\n' });

    const listing = await run('fs_list_dir', { recursive: true });
    const listed = (listing.output!['entries'] as Array<{ path: string }>).map((e) => e.path);
    expect(listed).toEqual(expect.arrayContaining(['source-code', 'source-code/app.ts', 'source-code/feature.ts']));
    expect(listed.some((p) => p.startsWith('.git') || p.startsWith('.ai-context') || p.startsWith('documentation'))).toBe(false);

    const diff = await run('git_diff', {});
    expect(diff.output).toMatchObject({ files: ['source-code/feature.ts'], truncated: false });
    expect(diff.output!['diff']).toContain('+export const f = () => 42;');

    const commit = await run('git_commit', { message: 'feat: add f' });
    expect(commit.output).toMatchObject({ committed: true, files: ['source-code/feature.ts'] });
    expect((await run('git_commit', { message: 'nothing' })).output).toEqual({ committed: false });
    const log = await run('git_log', { limit: 2 });
    expect((log.output!['commits'] as Array<{ subject: string }>)[0]!.subject).toBe('feat: add f');
    expect(await run('git_status', {})).toMatchObject({ status: 'succeeded', output: { changes: [] } });
    expect((await run('git_check_merge', {})).output).toEqual({ clean: true, conflicts: [] });

    // The work lives on the task branch only; the main checkout is untouched.
    const worktree = taskWorktreeDir(root, workspaceId, projectKey, task.id);
    expect((await runGit(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe(`task/${task.id}`);
    await expect(fs.access(path.join(repoDir, 'source-code', 'feature.ts'))).rejects.toThrow();

    // Pre-merge conflict detection: main changes the same file differently.
    await run('fs_write_file', { path: 'source-code/app.ts', content: 'export const v = 2;\n' });
    await run('git_commit', { message: 'bump v' });
    await fs.writeFile(path.join(repoDir, 'source-code', 'app.ts'), 'export const v = 3;\n');
    await runGit(repoDir, ['commit', '-qam', 'main bump']);
    expect((await run('git_check_merge', {})).output).toEqual({ clean: false, conflicts: ['source-code/app.ts'] });
    expect((await run('git_check_merge', { targetBranch: '--output=/tmp/x' })).status).toBe('failed');

    // Every call is recorded; file contents are never stored.
    const log2 = await conn.db.select().from(toolExecutions).where(eq(toolExecutions.taskId, task.id));
    expect(log2.length).toBe(13);
    const writeRow = log2.find((r) => r.toolKey === 'fs_write_file')!;
    expect(JSON.stringify(writeRow.input)).not.toContain('42');
    expect(writeRow.input['content']).toMatchObject({ omitted: true });
    const readRow = log2.find((r) => r.toolKey === 'fs_read_file')!;
    expect(readRow.output).toMatchObject({ summarized: true });
    expect(JSON.stringify(readRow.output)).not.toContain('export const v');

    await removeTaskWorktree(repoDir, worktree);
    await expect(fs.access(worktree)).rejects.toThrow();
    expect((await runGit(repoDir, ['branch', '--list', `task/${task.id}`])).stdout).toContain(`task/${task.id}`);
  });

  it('ESCAPE TESTS: blocks traversal, absolute paths, protected areas and links out of the workspace', async () => {
    const { task, actor, executionId } = await newRunningTask();
    const run = (toolKey: string, input: unknown) => executeTool(deps, actor, { toolKey, input, taskExecutionId: executionId });
    await run('git_status', {}); // creates the worktree
    const worktree = taskWorktreeDir(root, workspaceId, projectKey, task.id);

    const attempts: Array<[string, unknown]> = [
      ['fs_read_file', { path: '../../../../../../etc/passwd' }],
      ['fs_read_file', { path: path.join(outside, 'secret.txt') }],
      ['fs_read_file', { path: 'source-code/../../tools/.git/config' }],
      ['fs_write_file', { path: '.git/hooks/post-checkout', content: 'curl evil' }],
      ['fs_write_file', { path: '.ai-context/01-requirements/overview.md', content: 'hijack' }],
      ['fs_delete_file', { path: '.git/HEAD' }],
      ['fs_read_file', { path: 'source-code/app.ts::$DATA' }],
    ];
    for (const [toolKey, input] of attempts) {
      const out = await run(toolKey, input);
      expect(out.status, JSON.stringify(input)).toBe('denied');
      expect(out.error!.code, JSON.stringify(input)).toBe('path_rejected');
    }

    // A directory junction / symlink planted inside the scope must not lead out of the workspace…
    await fs.symlink(outside, path.join(worktree, 'source-code', 'escape'), 'junction');
    for (const [toolKey, input] of [
      ['fs_read_file', { path: 'source-code/escape/secret.txt' }],
      ['fs_write_file', { path: 'source-code/escape/planted.txt', content: 'x' }],
      ['fs_delete_file', { path: 'source-code/escape/secret.txt' }],
    ] as const) {
      const out = await run(toolKey, input);
      expect(out, toolKey).toMatchObject({ status: 'denied', error: { code: 'path_rejected' } });
    }
    // …nor into the repository internals.
    await fs.symlink(path.join(repoDir, '.git'), path.join(worktree, 'source-code', 'gitlink'), 'junction');
    expect((await run('fs_read_file', { path: 'source-code/gitlink/config' })).error!.code).toBe('path_rejected');
    // A dangling link (target missing now, maybe planted later) is refused, not treated as absent.
    await fs.symlink(path.join(outside, 'not-yet'), path.join(worktree, 'source-code', 'dangling'), 'junction');
    expect((await run('fs_write_file', { path: 'source-code/dangling/x.txt', content: 'x' })).error!.code).toBe('path_rejected');
    await expect(fs.access(path.join(outside, 'not-yet'))).rejects.toThrow();
    // Listings never follow links.
    const listing = await run('fs_list_dir', { path: 'source-code', recursive: true });
    expect(JSON.stringify(listing.output)).not.toContain('secret.txt');

    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET');
    await expect(fs.access(path.join(outside, 'planted.txt'))).rejects.toThrow();
  });

  it('denies by permission dimension and explains which one failed', async () => {
    const { actor, executionId, task } = await newRunningTask({ allowedTools: ['fs_read_file'] });
    const run = (toolKey: string, input: unknown, a: Actor = actor, ex: string | null = executionId) =>
      executeTool(deps, a, { toolKey, input, taskExecutionId: ex });

    expect((await run('shell_exec', { cmd: 'rm -rf /' })).error!.code).toBe('unknown_tool');
    expect((await run('fs_read_file', { path: 'x', extra: true })).error!.code).toBe('invalid_input');
    // Task narrows the agent's tools.
    const narrowed = await run('fs_write_file', { path: 'source-code/x.ts', content: 'x' });
    expect(narrowed.error!.message).toMatch(/^tool: .*task's allowed_tools/);
    // File scope: documentation is outside the developer's scopes.
    const t2 = await newRunningTask();
    const scoped = await executeTool(deps, t2.actor, { toolKey: 'fs_read_file', input: { path: 'documentation/x.md' }, taskExecutionId: t2.executionId });
    expect(scoped.error!.message).toMatch(/^file_scope: outside allowed file scopes: documentation\/x.md/);
    // A stale worker that lost its lease.
    expect((await run('fs_read_file', { path: 'source-code/app.ts' }, actor, uuidv7())).error!.message).toMatch(/^task: .*without a held lease/);
    // Another agent role impersonating the bound one.
    const qa: Actor = { ...actor, agentKey: 'qa' } as Actor;
    expect((await run('fs_read_file', { path: 'source-code/app.ts' }, qa)).error!.message).toMatch(/^agent:/);
    // Expired lease.
    clock = new Date(clock.getTime() + 3_600_000);
    expect((await run('fs_read_file', { path: 'source-code/app.ts' })).error!.message).toMatch(/^task:/);
    clock = new Date();
    // Task no longer running.
    await conn.db.update(tasks).set({ status: 'completed' }).where(eq(tasks.id, task.id));
    expect((await run('fs_read_file', { path: 'source-code/app.ts' })).error!.message).toMatch(/^task: task is 'completed'/);
    // Users and system actors cannot call agent tools at all.
    await expect(
      executeTool(deps, { type: 'system', workspaceId, component: 'x' }, { toolKey: 'fs_read_file', input: { path: 'a' } }),
    ).rejects.toThrow(/agents bound to a task/);

    const denials = await conn.db.select().from(auditLogs).where(eq(auditLogs.action, 'tool.denied'));
    expect(denials.length).toBeGreaterThanOrEqual(7);
  });

  it('per-tool permissions narrow file scopes and gate risk', async () => {
    await conn.db.insert(toolPermissions).values({
      workspaceId,
      subjectType: 'agent_version',
      subjectId: versionId,
      toolKey: 'fs_write_file',
      fileScopes: ['tests/**'],
      maxRisk: 'low',
      createdBy: 'test',
    });
    try {
      const { actor, executionId } = await newRunningTask();
      const run = (path_: string) =>
        executeTool(deps, actor, { toolKey: 'fs_write_file', input: { path: path_, content: 'x' }, taskExecutionId: executionId });
      const out = await run('tests/a.test.ts');
      expect(out.error!.message).toMatch(/^risk: risk 'medium' exceeds 'low'/);
      await conn.db.update(toolPermissions).set({ maxRisk: 'medium' }).where(eq(toolPermissions.subjectId, versionId));
      expect((await run('tests/a.test.ts')).status).toBe('succeeded');
      expect((await run('source-code/b.ts')).error!.message).toMatch(/^file_scope:/);
    } finally {
      await conn.db.delete(toolPermissions).where(eq(toolPermissions.subjectId, versionId));
    }
  });

  it('refuses destructive git even for platform code, unless an approval is given', async () => {
    await expect(runGit(repoDir, ['reset', '--hard', 'HEAD~1'])).rejects.toBeInstanceOf(DestructiveGitError);
    await expect(runGit(repoDir, ['branch', '-D', 'main'])).rejects.toBeInstanceOf(DestructiveGitError);
    await expect(runGit(repoDir, ['push', '--force', 'origin', 'main'])).rejects.toBeInstanceOf(DestructiveGitError);
    const head = (await runGit(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();
    expect((await runGit(repoDir, ['log', '-1', '--format=%H'])).stdout.trim()).toBe(head);
  });

  it('keeps the tool execution log append-only', async () => {
    const [row] = await conn.db.select().from(toolExecutions).limit(1);
    await expect(conn.db.execute(sql`update tool_executions set status = 'succeeded' where id = ${row!.id}`)).rejects.toThrow();
    await expect(conn.db.execute(sql`delete from tool_executions where id = ${row!.id}`)).rejects.toThrow();
    expect((await conn.db.select().from(workspaces)).length).toBe(1);
  });
});
