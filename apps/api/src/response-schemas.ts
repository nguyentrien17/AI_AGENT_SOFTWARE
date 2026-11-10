import type { FastifyInstance } from 'fastify';
import { type TObject, type TProperties, type TSchema, Type } from '@sinclair/typebox';

/**
 * Response documentation for OpenAPI (Phase 1 risk R3). Every schema allows additional properties, so a
 * documented response is never truncated by the serializer; the declared fields are the contract that
 * clients (and the Web UI) may rely on.
 */
const open = <T extends TProperties>(props: T, description: string): TObject<T> =>
  Type.Object(props, { additionalProperties: true, description });

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const NullableDateTime = Type.Union([DateTime, Type.Null()]);

export const ProblemSchema = open(
  {
    type: Type.String(),
    title: Type.String(),
    status: Type.Integer(),
    code: Type.String({ description: 'Machine-readable error code, e.g. validation_error, routing_halted' }),
    detail: Type.Optional(Type.String()),
    instance: Type.Optional(Type.String()),
    requestId: Type.Optional(Type.String()),
  },
  'RFC 7807 problem details',
);

const User = open({ id: Id, email: Type.String(), displayName: Type.String() }, 'User');
const Project = open(
  { id: Id, workspaceId: Id, key: Type.String(), name: Type.String(), status: Type.String(), createdAt: DateTime },
  'Project',
);
const Task = open(
  {
    id: Id,
    projectId: Id,
    title: Type.String(),
    objective: Type.String(),
    status: Type.String(),
    statusReason: Type.Union([Type.String(), Type.Null()]),
    agentRole: Type.Union([Type.String(), Type.Null()]),
    retryCount: Type.Integer(),
    maxRetries: Type.Integer(),
    workflowRunId: Type.Union([Id, Type.Null()]),
    createdAt: DateTime,
    version: Type.Integer(),
  },
  'Task',
);
const Artifact = open(
  { id: Id, projectId: Id, path: Type.String(), type: Type.String(), currentVersionNo: Type.Integer(), approvedVersionNo: Type.Union([Type.Integer(), Type.Null()]) },
  'Versioned artifact (context item)',
);
const WorkflowRun = open(
  { id: Id, projectId: Id, workflowVersionId: Id, status: Type.String(), pausedReason: Type.Union([Type.String(), Type.Null()]), startedAt: DateTime, endedAt: NullableDateTime },
  'Workflow run',
);
const WorkflowStep = open(
  { id: Id, runId: Id, stageKey: Type.String(), position: Type.Integer(), status: Type.String(), taskId: Type.Union([Id, Type.Null()]) },
  'Workflow step',
);
const RunDetail = open({ run: WorkflowRun, steps: Type.Array(WorkflowStep) }, 'Workflow run with its steps');
const Approval = open(
  { id: Id, projectId: Id, kind: Type.String(), status: Type.String(), title: Type.String(), taskId: Type.Union([Id, Type.Null()]), createdAt: DateTime },
  'Human approval request',
);
const Agent = open({ id: Id, agentKey: Type.String(), name: Type.String(), role: Type.String(), status: Type.String() }, 'Agent');
const Workflow = open({ id: Id, key: Type.String(), name: Type.String(), currentVersionId: Type.Union([Id, Type.Null()]) }, 'Workflow');
const Provider = open(
  {
    id: Id,
    providerKey: Type.String(),
    displayName: Type.String(),
    adapterType: Type.String(),
    baseUrl: Type.String(),
    enabled: Type.Boolean(),
    healthStatus: Type.String(),
    credential: open({ hasCredential: Type.Boolean() }, 'Credential summary — never the key itself'),
  },
  'AI provider',
);
const Model = open(
  { id: Id, providerId: Id, modelKey: Type.String(), qualityTier: Type.String(), availability: Type.String(), metadataVerified: Type.Boolean() },
  'AI model',
);
const Tool = open({ toolKey: Type.String(), description: Type.String(), risk: Type.String(), action: Type.String() }, 'Agent tool');
const Event = open(
  { id: Id, type: Type.String(), aggregateType: Type.String(), aggregateId: Type.String(), createdAt: DateTime },
  'Project event (outbox)',
);

const List = (item: TSchema, description: string) => open({ items: Type.Array(item) }, description);
const Page = (item: TSchema, description: string) =>
  open({ items: Type.Array(item), nextCursor: Type.Union([Type.String(), Type.Null()]) }, `${description} (pass nextCursor as ?cursor= for the next page)`);

/** Documented success responses, keyed by `METHOD path` (path without the /api/v1 prefix). */
export const DOCUMENTED_RESPONSES: Readonly<Record<string, { status: number; schema: TSchema }>> = {
  'GET /auth/status': { status: 200, schema: open({ bootstrapped: Type.Boolean(), authenticated: Type.Boolean() }, 'Platform status') },
  'GET /auth/me': { status: 200, schema: open({ user: User, workspaceId: Id, role: Type.String() }, 'Current session') },
  'GET /projects': { status: 200, schema: List(Project, 'Projects') },
  'POST /projects': { status: 201, schema: Project },
  'GET /projects/:id': { status: 200, schema: Project },
  'GET /projects/:id/tasks': { status: 200, schema: Page(Task, 'Tasks') },
  'GET /tasks/:id': { status: 200, schema: Task },
  'GET /projects/:id/artifacts': { status: 200, schema: Page(Artifact, 'Artifacts') },
  'GET /projects/:id/workflow-runs': { status: 200, schema: Page(WorkflowRun, 'Workflow runs') },
  'POST /projects/:id/workflow-runs': { status: 201, schema: RunDetail },
  'GET /workflow-runs/:id': { status: 200, schema: RunDetail },
  'GET /projects/:id/approvals': { status: 200, schema: Page(Approval, 'Approvals') },
  'POST /approvals/:id/decision': { status: 200, schema: Approval },
  'GET /agents': { status: 200, schema: List(Agent, 'Agents') },
  'GET /workflows': { status: 200, schema: List(Workflow, 'Workflows') },
  'GET /ai/providers': { status: 200, schema: List(Provider, 'AI providers') },
  'GET /ai/models': { status: 200, schema: List(Model, 'AI models') },
  'GET /tools': { status: 200, schema: List(Tool, 'Agent tools') },
  'GET /projects/:id/events': { status: 200, schema: List(Event, 'Project events') },
};

/**
 * Adds response documentation to every route registered after this call: RFC 7807 problem details for all
 * error statuses, plus the documented success schema where one is defined.
 */
export function registerResponseDocs(api: FastifyInstance, prefix: string) {
  api.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const path = route.url.startsWith(prefix) ? route.url.slice(prefix.length) : route.url;
    const schema = (route.schema ??= {}) as { response?: Record<string, TSchema>; hide?: boolean };
    if (schema.hide) return;
    const response = (schema.response ??= {});
    response['4xx'] ??= ProblemSchema;
    response['5xx'] ??= ProblemSchema;
    for (const m of methods) {
      const doc = DOCUMENTED_RESPONSES[`${m} ${path}`];
      if (doc) response[String(doc.status)] ??= doc.schema;
    }
  });
}
