import { ValidationError } from '@platform/shared';
import { gitCheckMerge, gitCommitAllChanges, gitDiffAgainstBase, gitLog, gitStatus } from '../git.js';
import { normalizeToolPath } from '../jail.js';
import type { ToolDefinition } from '../types.js';

const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;

export const gitStatusTool: ToolDefinition<Record<string, never>> = {
  toolKey: 'git_status',
  description: 'Show changed, added and deleted files in the task workspace.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: { type: 'object', required: ['changes'], properties: { changes: { type: 'array' } } },
  action: 'git_read',
  requiredScopes: ['workspace:read'],
  timeoutSeconds: 30,
  risk: 'low',
  idempotent: true,
  requiresSandbox: false,
  redaction: {},
  runtimes: ['any'],
  pathFields: [],
  async handler(ctx) {
    return { changes: await gitStatus(ctx.worktreeDir) };
  },
};

export const gitDiffTool: ToolDefinition<{ paths?: string[] }> = {
  toolKey: 'git_diff',
  description: 'Unified diff of everything this task changed since it branched (untracked files included).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { paths: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 500 } } },
  },
  outputSchema: {
    type: 'object',
    required: ['diff', 'truncated', 'files'],
    properties: { diff: { type: 'string' }, truncated: { type: 'boolean' }, files: { type: 'array' } },
  },
  action: 'git_read',
  requiredScopes: ['workspace:read'],
  timeoutSeconds: 30,
  risk: 'low',
  idempotent: true,
  requiresSandbox: false,
  redaction: { summarizeOutput: true },
  runtimes: ['any'],
  pathFields: [],
  async handler(ctx, input) {
    // Literal pathspecs only: `:(glob)` magic or similar must not widen what is diffed.
    const paths = (input.paths ?? []).map((p) => `:(literal)${normalizeToolPath(p)}`);
    return gitDiffAgainstBase(ctx.worktreeDir, ctx.baseBranch, { paths });
  },
};

export const gitCommitTool: ToolDefinition<{ message: string }> = {
  toolKey: 'git_commit',
  description: "Commit all workspace changes to this task's branch.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['message'],
    properties: { message: { type: 'string', minLength: 3, maxLength: 2000 } },
  },
  outputSchema: {
    type: 'object',
    required: ['committed'],
    properties: { committed: { type: 'boolean' }, sha: { type: 'string' }, files: { type: 'array' } },
  },
  action: 'git_commit',
  requiredScopes: ['workspace:write'],
  timeoutSeconds: 60,
  risk: 'medium',
  idempotent: false,
  requiresSandbox: false,
  redaction: {},
  runtimes: ['any'],
  pathFields: [],
  async handler(ctx, input) {
    const message = `${input.message.trim()}\n\nTask: ${ctx.taskId}`;
    const result = await gitCommitAllChanges(ctx.worktreeDir, message);
    return result ? { committed: true, sha: result.sha, files: result.files } : { committed: false };
  },
};

export const gitLogTool: ToolDefinition<{ limit?: number }> = {
  toolKey: 'git_log',
  description: "Recent commits on this task's branch.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
  },
  outputSchema: { type: 'object', required: ['commits'], properties: { commits: { type: 'array' } } },
  action: 'git_read',
  requiredScopes: ['workspace:read'],
  timeoutSeconds: 30,
  risk: 'low',
  idempotent: true,
  requiresSandbox: false,
  redaction: {},
  runtimes: ['any'],
  pathFields: [],
  async handler(ctx, input) {
    return { commits: await gitLog(ctx.worktreeDir, input.limit ?? 20) };
  },
};

export const gitCheckMergeTool: ToolDefinition<{ targetBranch?: string }> = {
  toolKey: 'git_check_merge',
  description: "Check, without merging, whether this task's branch merges cleanly into the target branch.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { targetBranch: { type: 'string', minLength: 1, maxLength: 100 } },
  },
  outputSchema: {
    type: 'object',
    required: ['clean', 'conflicts'],
    properties: { clean: { type: 'boolean' }, conflicts: { type: 'array' } },
  },
  action: 'git_read',
  requiredScopes: ['workspace:read'],
  timeoutSeconds: 60,
  risk: 'low',
  idempotent: true,
  requiresSandbox: false,
  redaction: {},
  runtimes: ['any'],
  pathFields: [],
  async handler(ctx, input) {
    const target = input.targetBranch ?? ctx.baseBranch;
    if (!BRANCH_RE.test(target)) throw new ValidationError(`'${target}' is not a valid branch name`);
    return gitCheckMerge(ctx.worktreeDir, target);
  },
};
