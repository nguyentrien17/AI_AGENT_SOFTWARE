import { spawn } from 'node:child_process';

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface RunProcessOptions {
  cwd: string;
  timeoutMs: number;
  /** Bytes kept per stream; the rest is dropped and reported as truncated. */
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

/** Kills the whole process tree, not only the direct child (Blueprint §11.2). */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/**
 * Runs a program with an argv array — never through a shell, so arguments cannot inject commands.
 * Enforces a hard timeout with process-tree termination and caps captured output.
 */
export function runProcess(command: string, args: readonly string[], opts: RunProcessOptions): Promise<ProcessResult> {
  const max = opts.maxOutputBytes ?? 1_000_000;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const streams = { out: { chunks: [] as Buffer[], size: 0 }, err: { chunks: [] as Buffer[], size: 0 } };
    let truncated = false;
    let timedOut = false;
    const collect = (target: { chunks: Buffer[]; size: number }) => (chunk: Buffer) => {
      const room = max - target.size;
      if (chunk.length > room) truncated = true;
      if (room <= 0) return;
      const kept = chunk.subarray(0, room);
      target.chunks.push(kept);
      target.size += kept.length;
    };
    child.stdout.on('data', collect(streams.out));
    child.stderr.on('data', collect(streams.err));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : code,
        stdout: Buffer.concat(streams.out.chunks).toString('utf8'),
        stderr: Buffer.concat(streams.err.chunks).toString('utf8'),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    });
  });
}
