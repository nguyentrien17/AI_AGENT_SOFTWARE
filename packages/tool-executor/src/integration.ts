import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runGit, taskBranch, withRepoLock } from './git.js';

export interface IntegrationResult {
  integrationBranch: string;
  merged: Array<{ branch: string; sha: string; alreadyMerged: boolean }>;
  conflict: { branch: string; files: string[] } | null;
  head: string;
}

export function integrationWorktreeDir(storageRoot: string, workspaceId: string, projectKey: string): string {
  return path.join(storageRoot, 'worktrees', workspaceId, projectKey, '_integration');
}

/**
 * Integration stage (Blueprint §8.1 stage 6, P7-08): merges finished task branches, in order, into the
 * integration branch inside its own worktree — the project's main checkout is never touched. The first
 * conflict stops the run; the merge is aborted (nothing is lost) and the conflicting files are reported.
 */
export async function integrateTaskBranches(input: {
  repoDir: string;
  worktreeDir: string;
  baseBranch: string;
  integrationBranch: string;
  taskIds: string[];
}): Promise<IntegrationResult> {
  return withRepoLock(input.repoDir, async () => {
    const exists = (await runGit(input.repoDir, ['branch', '--list', input.integrationBranch])).stdout.trim();
    if (!exists) await runGit(input.repoDir, ['branch', input.integrationBranch, input.baseBranch]);
    const hasWorktree = await fs.access(path.join(input.worktreeDir, '.git')).then(
      () => true,
      () => false,
    );
    if (!hasWorktree) {
      await fs.mkdir(path.dirname(input.worktreeDir), { recursive: true });
      await runGit(input.repoDir, ['worktree', 'prune']);
      await runGit(input.repoDir, ['worktree', 'add', input.worktreeDir, input.integrationBranch]);
    }
    const wt = input.worktreeDir;
    const merged: IntegrationResult['merged'] = [];
    let conflict: IntegrationResult['conflict'] = null;
    for (const taskId of input.taskIds) {
      const branch = taskBranch(taskId);
      if (!(await runGit(input.repoDir, ['branch', '--list', branch])).stdout.trim()) continue; // no code changes
      const already = await runGit(wt, ['merge-base', '--is-ancestor', branch, 'HEAD'], { allowExitCodes: [1] });
      if (already.exitCode === 0) {
        merged.push({ branch, sha: (await runGit(wt, ['rev-parse', 'HEAD'])).stdout.trim(), alreadyMerged: true });
        continue;
      }
      const res = await runGit(wt, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${branch} into ${input.integrationBranch}`, branch], {
        allowExitCodes: [1],
        timeoutMs: 120_000,
      });
      if (res.exitCode !== 0) {
        const files = (await runGit(wt, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
        await runGit(wt, ['merge', '--abort']);
        conflict = { branch, files };
        break;
      }
      merged.push({ branch, sha: (await runGit(wt, ['rev-parse', 'HEAD'])).stdout.trim(), alreadyMerged: false });
    }
    return {
      integrationBranch: input.integrationBranch,
      merged,
      conflict,
      head: (await runGit(wt, ['rev-parse', 'HEAD'])).stdout.trim(),
    };
  });
}
