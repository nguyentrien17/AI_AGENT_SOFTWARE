import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Platform-level repository initialization (not an agent tool — agent Git access goes through the
 * Tool Executor in Phase 6). Uses argv arrays only; never shell interpolation.
 */
export async function gitInit(dir: string, defaultBranch = 'main'): Promise<void> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  await run('git', ['init', '-q', '-b', defaultBranch], { cwd: dir, env, timeout: 30_000 });
  await run('git', ['config', 'user.name', 'AI Agent Platform'], { cwd: dir, env, timeout: 30_000 });
  await run('git', ['config', 'user.email', 'platform@localhost'], { cwd: dir, env, timeout: 30_000 });
  await run('git', ['add', '-A'], { cwd: dir, env, timeout: 30_000 });
  await run('git', ['commit', '-q', '-m', 'chore: initialize project workspace'], { cwd: dir, env, timeout: 30_000 });
}

export async function gitAvailable(): Promise<boolean> {
  try {
    await run('git', ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
