import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  createAgent,
  getAgent,
  listAgents,
  listAgentVersions,
  publishAgentVersion,
  seedAgentLibrary,
  setAgentStatus,
} from '@platform/agent-runtime';
import {
  cancelWorkflowRun,
  createWorkflow,
  decideApproval,
  getTask,
  getWorkflow,
  getWorkflowRun,
  listApprovals,
  listProjectEvents,
  listTaskExecutions,
  listWorkflowRuns,
  listWorkflows,
  pauseWorkflowRun,
  publishWorkflowVersion,
  resumeWorkflowRun,
  seedWorkflowLibrary,
  startWorkflowRun,
} from '@platform/orchestration';
import { actorOf } from '../auth-plugin.js';
import type { AppDeps } from '../deps.js';
import { IdParams, strict, Uuid } from '../schemas.js';

const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((v) => Type.Literal(v)));
const JsonObject = Type.Record(Type.String(), Type.Unknown());
const StringList = Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 100 });

const AgentDefinitionSchema = Type.Object(
  {
    systemInstruction: Type.String({ minLength: 1, maxLength: 100_000 }),
    inputSchema: Type.Optional(JsonObject),
    outputSchema: Type.Optional(JsonObject),
    allowedTools: Type.Optional(StringList),
    allowedFileScopes: Type.Optional(StringList),
    allowedActions: Type.Optional(StringList),
    modelConfigRef: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
    retryPolicy: Type.Optional(Type.Object({ maxOutputRepairs: Type.Optional(Type.Integer({ minimum: 0 })) }, strict)),
    completionCriteria: Type.Optional(StringList),
  },
  strict,
);

const SSE_POLL_MS = 1_000;
const SSE_KEEPALIVE_MS = 15_000;

/** Phase 5 HTTP surface: agent registry, workflows, runs, approvals, executions and the project event stream. */
export function workflowRoutes(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const { db } = deps;
  const libraryDir = deps.agentLibraryDir ?? path.resolve('agent-library');

  // ------------------------------------------------------------------ Agent registry
  r.get('/agents', async (req) => ({ items: await listAgents(db, actorOf(req)) }));

  r.post(
    '/agents',
    {
      schema: {
        body: Type.Object(
          {
            agentKey: Type.String({ minLength: 2, maxLength: 40 }),
            name: Type.String({ minLength: 1, maxLength: 120 }),
            description: Type.Optional(Type.String({ maxLength: 2000 })),
            role: Type.String({ minLength: 2, maxLength: 40 }),
            definition: AgentDefinitionSchema,
          },
          strict,
        ),
      },
    },
    async (req, reply) => reply.code(201).send(await createAgent(db, actorOf(req), req.body as never)),
  );

  r.post('/agents/seed', async (req) => ({ items: await seedAgentLibrary(db, actorOf(req), libraryDir) }));

  r.get('/agents/:id', { schema: { params: IdParams } }, async (req) => getAgent(db, actorOf(req), req.params.id));

  r.get('/agents/:id/versions', { schema: { params: IdParams } }, async (req) => ({
    items: await listAgentVersions(db, actorOf(req), req.params.id),
  }));

  r.post(
    '/agents/:id/versions',
    { schema: { params: IdParams, body: AgentDefinitionSchema } },
    async (req, reply) => {
      const { version, created } = await publishAgentVersion(db, actorOf(req), req.params.id, req.body as never);
      return reply.code(created ? 201 : 200).send({ ...version, created });
    },
  );

  r.put(
    '/agents/:id/status',
    {
      schema: {
        params: IdParams,
        body: Type.Object({ status: literals(['active', 'disabled', 'deprecated'] as const) }, strict),
      },
    },
    async (req) => setAgentStatus(db, actorOf(req), req.params.id, req.body.status),
  );

  // ------------------------------------------------------------------ Workflow definitions
  r.get('/workflows', async (req) => ({ items: await listWorkflows(db, actorOf(req)) }));

  r.post(
    '/workflows',
    {
      schema: {
        body: Type.Object(
          {
            key: Type.String({ minLength: 1, maxLength: 60 }),
            name: Type.String({ minLength: 1, maxLength: 120 }),
            description: Type.Optional(Type.String({ maxLength: 2000 })),
            definition: JsonObject,
          },
          strict,
        ),
      },
    },
    async (req, reply) => reply.code(201).send(await createWorkflow(db, actorOf(req), req.body)),
  );

  r.post('/workflows/seed', async (req) => ({ items: await seedWorkflowLibrary(db, actorOf(req), libraryDir) }));

  r.get('/workflows/:id', { schema: { params: IdParams } }, async (req) =>
    getWorkflow(db, actorOf(req), req.params.id),
  );

  r.post(
    '/workflows/:id/versions',
    { schema: { params: IdParams, body: Type.Object({ definition: JsonObject }, strict) } },
    async (req, reply) =>
      reply.code(201).send(await publishWorkflowVersion(db, actorOf(req), req.params.id, req.body.definition)),
  );

  // ------------------------------------------------------------------ Runs
  r.post(
    '/projects/:id/workflow-runs',
    {
      schema: {
        params: IdParams,
        body: Type.Object({ workflowId: Uuid, variables: Type.Optional(JsonObject) }, strict),
      },
    },
    async (req, reply) =>
      reply.code(201).send(
        await startWorkflowRun(db, actorOf(req), {
          projectId: req.params.id,
          workflowId: req.body.workflowId,
          ...(req.body.variables ? { variables: req.body.variables } : {}),
        }),
      ),
  );

  r.get('/projects/:id/workflow-runs', { schema: { params: IdParams } }, async (req) => ({
    items: await listWorkflowRuns(db, actorOf(req), req.params.id),
  }));

  r.get('/workflow-runs/:id', { schema: { params: IdParams } }, async (req) =>
    getWorkflowRun(db, actorOf(req), req.params.id),
  );

  const ReasonBody = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 500 }) }, strict);
  r.post('/workflow-runs/:id/pause', { schema: { params: IdParams, body: ReasonBody } }, async (req) =>
    pauseWorkflowRun(db, actorOf(req), req.params.id, req.body.reason),
  );
  r.post('/workflow-runs/:id/resume', { schema: { params: IdParams } }, async (req) =>
    resumeWorkflowRun(db, actorOf(req), req.params.id),
  );
  r.post('/workflow-runs/:id/cancel', { schema: { params: IdParams, body: ReasonBody } }, async (req) =>
    cancelWorkflowRun(db, actorOf(req), req.params.id, req.body.reason),
  );

  r.get('/tasks/:id/executions', { schema: { params: IdParams } }, async (req) => {
    const task = await getTask(db, actorOf(req), req.params.id); // authorizes task.read
    return { items: await listTaskExecutions(db, task.id) };
  });

  // ------------------------------------------------------------------ Approvals
  r.get(
    '/projects/:id/approvals',
    {
      schema: {
        params: IdParams,
        querystring: Type.Object({
          status: Type.Optional(literals(['pending', 'approved', 'rejected', 'cancelled'] as const)),
        }),
      },
    },
    async (req) => ({ items: await listApprovals(db, actorOf(req), req.params.id, req.query) }),
  );

  r.post(
    '/approvals/:id/decision',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            decision: literals(['approved', 'rejected'] as const),
            comment: Type.Optional(Type.String({ maxLength: 4000 })),
          },
          strict,
        ),
      },
    },
    async (req) => decideApproval(db, actorOf(req), req.params.id, req.body),
  );

  // ------------------------------------------------------------------ Events
  const EventsQuery = Type.Object({
    after: Type.Optional(Uuid),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  });

  r.get('/projects/:id/events', { schema: { params: IdParams, querystring: EventsQuery } }, async (req) => ({
    items: await listProjectEvents(db, actorOf(req), req.params.id, req.query),
  }));

  /**
   * Server-Sent Events stream of the project's outbox events (P5-10). Resumes from `Last-Event-ID` or
   * `?after=`. `follow=false` sends the backlog and closes, which suits polling clients and tests.
   */
  r.get(
    '/projects/:id/events/stream',
    {
      schema: {
        params: IdParams,
        querystring: Type.Object({ after: Type.Optional(Uuid), follow: Type.Optional(Type.Boolean()) }),
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const projectId = req.params.id;
      const header = req.headers['last-event-id'];
      let cursor = (typeof header === 'string' && /^[0-9a-f-]{36}$/i.test(header) ? header : undefined) ?? req.query.after;
      // Authorize (and fail as JSON) before switching the response to an event stream.
      const first = await listProjectEvents(db, actor, projectId, { ...(cursor ? { after: cursor } : {}), limit: 500 });

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (events: typeof first) => {
        for (const e of events) {
          res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          cursor = e.id;
        }
      };
      send(first);
      if (req.query.follow === false) {
        res.end();
        return;
      }

      let closed = false;
      let lastWrite = Date.now();
      const poll = setInterval(() => {
        void (async () => {
          if (closed) return;
          try {
            const next = await listProjectEvents(db, actor, projectId, { ...(cursor ? { after: cursor } : {}), limit: 500 });
            if (next.length) {
              send(next);
              lastWrite = Date.now();
            } else if (Date.now() - lastWrite > SSE_KEEPALIVE_MS) {
              res.write(': keep-alive\n\n');
              lastWrite = Date.now();
            }
          } catch {
            stop(); // access revoked or database gone: end the stream
          }
        })();
      }, SSE_POLL_MS);
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        res.end();
      };
      req.raw.on('close', stop);
    },
  );
}
