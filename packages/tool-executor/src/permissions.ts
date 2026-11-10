import { matchesAny } from './glob.js';
import { RISK_RANK, type ToolAction, type ToolRisk } from './types.js';

export const DEFAULT_MAX_RISK: ToolRisk = 'medium';

export type PermissionDimension = 'project' | 'agent' | 'task' | 'tool' | 'file_scope' | 'action' | 'risk';
export type Verdict = 'allow' | 'deny' | 'require_approval';

export interface DimensionResult {
  dimension: PermissionDimension;
  ok: boolean;
  detail: string;
}

export interface PermissionDecision {
  verdict: Verdict;
  dimensions: DimensionResult[];
  /** First failing dimension, for error messages. */
  reason: string | null;
  /** Set when a human approval authorized this (otherwise `require_approval`) call. */
  approvalId?: string;
}

export interface PermissionInput {
  project: { ok: boolean; detail: string };
  agent: {
    status: 'active' | 'disabled' | 'deprecated' | null;
    allowedTools: readonly string[];
    allowedActions: readonly string[];
    allowedFileScopes: readonly string[];
  };
  task: { status: string; leaseHeld: boolean; allowedTools: readonly string[] };
  tool: { toolKey: string; action: ToolAction; risk: ToolRisk; registered: boolean };
  paths: Array<{ path: string; access: 'read' | 'write' }>;
  /** Optional per-tool narrowing (`tool_permissions`). */
  override: { fileScopes: readonly string[]; maxRisk: ToolRisk } | null;
}

/**
 * The 7-dimension agent permission check (Blueprint §16.2, docs/phase-0/07-security-model.md §4):
 * `Project × Agent × Task × Tool × FilePathScope × ActionType × RiskLevel`. Deny by default; every
 * dimension is evaluated and reported so a denial is explainable. Pure.
 */
export function evaluateToolPermission(input: PermissionInput): PermissionDecision {
  const dims: DimensionResult[] = [];
  const add = (dimension: PermissionDimension, ok: boolean, detail: string) => dims.push({ dimension, ok, detail });
  const { agent, task, tool } = input;

  add('project', input.project.ok, input.project.detail);
  add('agent', agent.status === 'active', agent.status === 'active' ? 'agent version active' : `agent is ${agent.status ?? 'unknown'}`);

  const taskOk = task.status === 'running' && task.leaseHeld;
  add(
    'task',
    taskOk,
    taskOk ? 'task running under a held lease' : `task is '${task.status}'${task.leaseHeld ? '' : ' without a held lease'}`,
  );

  const inAgent = agent.allowedTools.includes(tool.toolKey);
  const inTask = task.allowedTools.length === 0 || task.allowedTools.includes(tool.toolKey);
  add(
    'tool',
    tool.registered && inAgent && inTask,
    !tool.registered
      ? `tool '${tool.toolKey}' is not registered`
      : !inAgent
        ? `tool '${tool.toolKey}' is not in the agent's allowed_tools`
        : !inTask
          ? `tool '${tool.toolKey}' is not in the task's allowed_tools`
          : 'tool allowed by agent and task',
  );

  const scopes = input.override?.fileScopes.length ? input.override.fileScopes : agent.allowedFileScopes;
  const outside = input.paths.filter((p) => !matchesAny(p.path, scopes));
  const agentOutside = input.override?.fileScopes.length
    ? input.paths.filter((p) => !matchesAny(p.path, agent.allowedFileScopes))
    : [];
  const blocked = [...new Set([...outside, ...agentOutside].map((p) => p.path))];
  add(
    'file_scope',
    blocked.length === 0 && (input.paths.length === 0 || scopes.length > 0),
    blocked.length ? `outside allowed file scopes: ${blocked.join(', ')}` : input.paths.length ? 'paths within file scopes' : 'no paths',
  );

  const actionOk = agent.allowedActions.includes(tool.action);
  add('action', actionOk, actionOk ? `action '${tool.action}' allowed` : `action '${tool.action}' is not in the agent's allowed_actions`);

  const maxRisk = input.override?.maxRisk ?? DEFAULT_MAX_RISK;
  const riskOk = RISK_RANK[tool.risk] <= RISK_RANK[maxRisk];
  add('risk', riskOk, riskOk ? `risk '${tool.risk}' ≤ '${maxRisk}'` : `risk '${tool.risk}' exceeds '${maxRisk}'`);

  const failed = dims.find((d) => !d.ok);
  if (failed) return { verdict: 'deny', dimensions: dims, reason: `${failed.dimension}: ${failed.detail}` };
  // Even when allowed, high and critical risk tools always need a human (Blueprint §16.3).
  if (RISK_RANK[tool.risk] >= RISK_RANK.high) {
    return { verdict: 'require_approval', dimensions: dims, reason: `risk: '${tool.risk}' requires human approval` };
  }
  return { verdict: 'allow', dimensions: dims, reason: null };
}
