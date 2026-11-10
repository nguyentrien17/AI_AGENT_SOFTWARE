import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { type Db, projects, repositories, tasks } from '@platform/db';
import { NotFoundError, ValidationError } from '@platform/shared';
import type { StorageAdapter } from '@platform/storage';
import { gitCheckMerge, gitDiffAgainstBase, runGit, taskWorktreeDir } from '@platform/tool-executor';
import { scanUnifiedDiff } from './secrets.js';

/** Deterministic checks (Blueprint §12.2). Those that execute project code need the sandbox. */
export const GATE_KEYS = [
  'secret_scan',
  'merge_check',
  'build',
  'lint',
  'unit_tests',
  'dependency_scan',
  'migration_check',
] as const;
export type GateKey = (typeof GATE_KEYS)[number];

/** Gates that must run untrusted project code (or its manifests) and therefore only inside a sandbox. */
export const SANDBOX_GATES: ReadonlySet<GateKey> = new Set(['build', 'lint', 'unit_tests', 'dependency_scan', 'migration_check']);

/** Applied to every task that used a workspace, whatever its stage says. */
export const DEFAULT_WORKSPACE_GATES: readonly GateKey[] = ['secret_scan', 'merge_check'];

export const SECRET_SCANNER_VERSION = 'platform-secret-scan/1';

export type GateOutcome = 'passed' | 'failed' | 'warning' | 'blocked' | 'requires_approval';

export interface GateEvidence {
  tool: string;
  toolVersion: string;
  command: string;
  environmentId: string;
  gitTreeHash: string | null;
  logUri: string | null;
  summary: string;
  [k: string]: unknown;
}

export interface GateResult {
  gateKey: GateKey;
  outcome: GateOutcome;
  evidence: GateEvidence;
}

export function validateGateKeys(keys: unknown): GateKey[] {
  if (keys === undefined) return [];
  if (!Array.isArray(keys) || keys.some((k) => !GATE_KEYS.includes(k as GateKey))) {
    throw new ValidationError(`gates must be a list of: ${GATE_KEYS.join(', ')}`);
  }
  return [...new Set(keys as GateKey[])];
}

let gitVersion: string | null = null;
async function gitToolVersion(cwd: string): Promise<string> {
  gitVersion ??= (await runGit(cwd, ['--version'])).stdout.trim();
  return gitVersion;
}

export interface GateRunDeps {
  db: Db;
  /** Root storage: holds the project repositories, task worktrees and the evidence blob store. */
  storage: StorageAdapter;
}

/**
 * Runs the requested deterministic gates for a task and returns immutable evidence for each (Blueprint
 * §12.4): tool, version, exact command, environment, git tree hash and the raw output stored as a blob.
 * Gates that need the sandbox report `blocked` instead of being skipped — completion is never assumed.
 */
export async function runQualityGates(deps: GateRunDeps, taskId: string, requested: readonly GateKey[]): Promise<GateResult[]> {
  const [row] = await deps.db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row) throw new NotFoundError('Task', taskId);
  const [repo] = await deps.db.select().from(repositories).where(eq(repositories.projectId, row.project.id)).limit(1);
  const baseBranch = repo?.defaultBranch ?? 'main';
  const worktree = taskWorktreeDir(deps.storage.root, row.project.workspaceId, row.project.key, taskId);
  const hasWorkspace = await fs.access(path.join(worktree, '.git')).then(
    () => true,
    () => false,
  );
  const environmentId = `host:${hostname()}`;

  let treeHash: string | null = null;
  if (hasWorkspace) {
    await runGit(worktree, ['add', '--all']);
    treeHash = (await runGit(worktree, ['write-tree'])).stdout.trim();
  }
  const storeLog = async (payload: unknown) => (await deps.storage.putBlob(JSON.stringify(payload, null, 2))).uri;

  const results: GateResult[] = [];
  for (const gateKey of requested) {
    if (SANDBOX_GATES.has(gateKey)) {
      results.push({
        gateKey,
        outcome: 'blocked',
        evidence: {
          tool: 'sandbox',
          toolVersion: 'unavailable',
          command: `run ${gateKey}`,
          environmentId,
          gitTreeHash: treeHash,
          logUri: null,
          summary: `'${gateKey}' executes project code and needs the isolated sandbox, which is not configured (sandbox_unavailable)`,
        },
      });
      continue;
    }
    if (!hasWorkspace) {
      results.push({
        gateKey,
        outcome: 'passed',
        evidence: {
          tool: gateKey === 'secret_scan' ? SECRET_SCANNER_VERSION : 'git',
          toolVersion: gateKey === 'secret_scan' ? '1' : 'n/a',
          command: 'n/a',
          environmentId,
          gitTreeHash: null,
          logUri: null,
          summary: 'task made no workspace changes',
        },
      });
      continue;
    }
    if (gateKey === 'secret_scan') {
      const diff = await gitDiffAgainstBase(worktree, baseBranch, { maxBytes: 5_000_000 });
      const findings = scanUnifiedDiff(diff.diff);
      results.push({
        gateKey,
        outcome: findings.length ? 'failed' : diff.truncated ? 'warning' : 'passed',
        evidence: {
          tool: SECRET_SCANNER_VERSION,
          toolVersion: '1',
          command: `scan added lines of: git diff ${baseBranch}...task/${taskId}`,
          environmentId,
          gitTreeHash: treeHash,
          logUri: await storeLog({ files: diff.files, truncated: diff.truncated, findings }),
          summary: findings.length
            ? `${findings.length} potential secret(s): ${findings
                .slice(0, 10)
                .map((f) => `${f.file}:${f.line} ${f.description}`)
                .join('; ')}`
            : diff.truncated
              ? 'diff too large to scan completely'
              : `no secrets in ${diff.files.length} changed file(s)`,
          findings,
        },
      });
    } else if (gateKey === 'merge_check') {
      const merge = await gitCheckMerge(worktree, baseBranch);
      results.push({
        gateKey,
        // A conflict cannot be fixed by retrying the agent: a human has to decide.
        outcome: merge.clean ? 'passed' : 'blocked',
        evidence: {
          tool: 'git merge-tree',
          toolVersion: await gitToolVersion(worktree),
          command: `git merge-tree --write-tree --name-only ${baseBranch} task/${taskId}`,
          environmentId,
          gitTreeHash: treeHash,
          logUri: await storeLog(merge),
          summary: merge.clean ? `merges cleanly into ${baseBranch}` : `conflicts with ${baseBranch}: ${merge.conflicts.join(', ')}`,
          conflicts: merge.conflicts,
        },
      });
    }
  }
  return results;
}
