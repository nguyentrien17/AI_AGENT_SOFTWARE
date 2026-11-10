import type { ToolRedactionPolicy } from '@platform/db';
import type { WorkspaceJail } from './jail.js';

export type ToolRisk = 'low' | 'medium' | 'high' | 'critical';
export const RISK_RANK: Readonly<Record<ToolRisk, number>> = { low: 1, medium: 2, high: 3, critical: 4 };

/** Action types of the 7-dimension permission model (Blueprint §16.2), matched against `allowed_actions`. */
export type ToolAction = 'read_file' | 'write_file' | 'delete_file' | 'git_read' | 'git_commit' | 'execute';

/** Everything a tool handler may use. Handlers never see platform secrets or other projects. */
export interface ToolContext {
  jail: WorkspaceJail;
  worktreeDir: string;
  baseBranch: string;
  taskId: string;
  /** Agent file scopes, so directory listings can hide what the agent may not see. */
  fileScopes: readonly string[];
}

export interface ToolDefinition<I = Record<string, unknown>, O = Record<string, unknown>> {
  /** Must match `^[a-z][a-z0-9_]*$`: provider function names allow no dots. */
  toolKey: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  action: ToolAction;
  requiredScopes: string[];
  timeoutSeconds: number;
  risk: ToolRisk;
  idempotent: boolean;
  /** Runs untrusted code: only inside a sandbox (Phase 6 part B). */
  requiresSandbox: boolean;
  redaction: ToolRedactionPolicy;
  /** Project runtimes the tool supports; `any` for runtime-independent tools. */
  runtimes: string[];
  /** Input fields that hold workspace paths, with the access they need (checked against file scopes). */
  pathFields: Array<{ field: string; access: 'read' | 'write' }>;
  handler: (ctx: ToolContext, input: I) => Promise<O>;
}

// Handlers are contravariant in their input; the catalog stores them type-erased.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;
