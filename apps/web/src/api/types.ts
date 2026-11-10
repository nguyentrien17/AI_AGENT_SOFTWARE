/** Response shapes used by the UI (see GET /api/v1/openapi.json for the full contract). */
export interface Page<T> {
  items: T[];
  nextCursor?: string | null;
}
export interface Me {
  user: { id: string; email: string; displayName: string };
  workspaceId: string;
  role: string;
}
export interface Project {
  id: string;
  key: string;
  name: string;
  description?: string;
  status: string;
  storagePath: string;
  createdAt: string;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  status: string;
  statusReason: string | null;
  agentRole: string | null;
  retryCount: number;
  maxRetries: number;
  workflowRunId: string | null;
  createdAt: string;
}
export interface Artifact {
  id: string;
  path: string;
  type: string;
  currentVersionNo: number;
  approvedVersionNo: number | null;
}
export interface WorkflowRun {
  id: string;
  projectId: string;
  status: string;
  pausedReason: string | null;
  variables: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
}
export interface WorkflowStep {
  id: string;
  stageKey: string;
  position: number;
  status: string;
  taskId: string | null;
  skipReason: string | null;
}
export interface RunDetail {
  run: WorkflowRun;
  steps: WorkflowStep[];
}
export interface Approval {
  id: string;
  kind: string;
  status: string;
  title: string;
  taskId: string | null;
  subject: Record<string, unknown>;
  comment: string | null;
  createdAt: string;
}
export interface Workflow {
  id: string;
  key: string;
  name: string;
  description: string;
}
export interface Agent {
  id: string;
  agentKey: string;
  name: string;
  role: string;
  status: string;
  currentVersion: { versionNo: number; allowedTools: string[]; skills: string[] } | null;
}
export interface Skill {
  id: string;
  skillKey: string;
  name: string;
  versionNo: number;
  description: string;
}
export interface Provider {
  id: string;
  providerKey: string;
  displayName: string;
  adapterType: string;
  baseUrl: string;
  enabled: boolean;
  healthStatus: string;
  lastError: string | null;
  credential: { hasCredential: boolean; maskedHint?: string | null };
}
export interface Model {
  id: string;
  providerId: string;
  providerKey: string;
  modelKey: string;
  qualityTier: string;
  availability: string;
  contextWindow: number | null;
  capabilities: Record<string, string>;
  activePricing: { inputPerMtok: string; outputPerMtok: string } | null;
}
export interface ModelConfig {
  id: string;
  scope: string;
  agentKey: string | null;
  scopeRefId: string | null;
  mode: string;
  primaryModelId: string | null;
  configVersion: number;
}
export interface Budget {
  id: string;
  level: string;
  scopeRefId: string | null;
  tokenLimit: number | null;
  costLimitUsd: string | null;
  consumedTokens: number;
  consumedCostUsd: string;
  utilizationPct: number;
  currentBand: string;
  halted: boolean;
}
export interface CostTotals {
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: string;
  unpricedInvocations: number;
}
export interface CostBreakdown {
  totals: CostTotals;
  groups: Array<{ key: string; label: string } & CostTotals>;
}
export interface ProjectEvent {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
