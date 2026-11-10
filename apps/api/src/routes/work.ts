import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  approveArtifactVersion,
  createArtifact,
  createArtifactVersion,
  getArtifact,
  listArtifacts,
  listArtifactVersions,
  readArtifactVersion,
} from '@platform/artifacts';
import {
  addDependency,
  createTask,
  getTask,
  getTaskHistory,
  listDependencies,
  listTasks,
  removeDependency,
  transitionTask,
  updateTask,
} from '@platform/orchestration';
import { actorOf } from '../auth-plugin.js';
import type { AppDeps } from '../deps.js';
import { ComplexitySchema, ExpectedVersion, IdParams, strict, TaskStatusSchema, Uuid } from '../schemas.js';

const MAX_CONTENT = 5 * 1024 * 1024;

const TaskFields = {
  title: Type.String({ minLength: 1, maxLength: 300 }),
  objective: Type.String({ minLength: 1, maxLength: 20_000 }),
  inputRefs: Type.Optional(
    Type.Array(
      Type.Object(
        { path: Type.String({ maxLength: 500 }), version: Type.Optional(Type.Integer({ minimum: 1 })) },
        strict,
      ),
      { maxItems: 200 },
    ),
  ),
  expectedOutput: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  acceptanceCriteria: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 100 })),
  agentRole: Type.Optional(Type.Union([Type.String({ maxLength: 60 }), Type.Null()])),
  allowedTools: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 100 })),
  tokenCeiling: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  costCeiling: Type.Optional(Type.Union([Type.String({ pattern: '^\\d+(\\.\\d{1,6})?$' }), Type.Null()])),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
  maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  complexity: Type.Optional(ComplexitySchema),
};

export function workRoutes(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const { db } = deps;
  const adeps = { db, storage: deps.storage };

  // ------------------------------------------------------------ artifacts
  r.get('/projects/:id/artifacts', { schema: { params: IdParams } }, async (req) => ({
    items: await listArtifacts(adeps, actorOf(req), req.params.id),
  }));

  r.post(
    '/projects/:id/artifacts',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            path: Type.String({ minLength: 1, maxLength: 500 }),
            type: Type.String({ minLength: 1, maxLength: 60 }),
            content: Type.String({ maxLength: MAX_CONTENT }),
            ownerRole: Type.Optional(Type.String({ maxLength: 60 })),
            changeNote: Type.Optional(Type.String({ maxLength: 2000 })),
          },
          strict,
        ),
      },
    },
    async (req, reply) =>
      reply.code(201).send(await createArtifact(adeps, actorOf(req), req.params.id, req.body)),
  );

  r.get('/artifacts/:id', { schema: { params: IdParams } }, async (req) =>
    getArtifact(adeps, actorOf(req), req.params.id),
  );

  r.get('/artifacts/:id/versions', { schema: { params: IdParams } }, async (req) => ({
    items: await listArtifactVersions(adeps, actorOf(req), req.params.id),
  }));

  r.post(
    '/artifacts/:id/versions',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            content: Type.String({ maxLength: MAX_CONTENT }),
            expectedVersionNo: Type.Integer({ minimum: 1 }),
            changeNote: Type.Optional(Type.String({ maxLength: 2000 })),
          },
          strict,
        ),
      },
    },
    async (req, reply) =>
      reply.code(201).send(await createArtifactVersion(adeps, actorOf(req), req.params.id, req.body)),
  );

  const VersionParams = Type.Object({
    id: Uuid,
    version: Type.Union([Type.Integer({ minimum: 1 }), Type.Literal('latest'), Type.Literal('approved')]),
  });

  r.get(
    '/artifacts/:id/versions/:version/content',
    { schema: { params: VersionParams } },
    async (req, reply) => {
      const { version, content } = await readArtifactVersion(
        adeps,
        actorOf(req),
        req.params.id,
        req.params.version as never,
      );
      reply
        .header('x-content-sha256', version.sha256)
        .header('x-artifact-version', String(version.versionNo));
      reply.header('x-content-type-options', 'nosniff');
      return reply.type('text/plain; charset=utf-8').send(content);
    },
  );

  r.post(
    '/artifacts/:id/versions/:version/approve',
    { schema: { params: Type.Object({ id: Uuid, version: Type.Integer({ minimum: 1 }) }) } },
    async (req) => approveArtifactVersion(adeps, actorOf(req), req.params.id, req.params.version),
  );

  // ------------------------------------------------------------ tasks
  r.get(
    '/projects/:id/tasks',
    { schema: { params: IdParams, querystring: Type.Object({ status: Type.Optional(TaskStatusSchema) }) } },
    async (req) => ({ items: await listTasks(db, actorOf(req), req.params.id, req.query as never) }),
  );

  r.post(
    '/projects/:id/tasks',
    { schema: { params: IdParams, body: Type.Object(TaskFields, strict) } },
    async (req, reply) =>
      reply.code(201).send(await createTask(db, actorOf(req), req.params.id, req.body as never)),
  );

  r.get('/tasks/:id', { schema: { params: IdParams } }, async (req) =>
    getTask(db, actorOf(req), req.params.id),
  );

  r.put(
    '/tasks/:id',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            ...Object.fromEntries(Object.entries(TaskFields).map(([k, v]) => [k, Type.Optional(v)])),
            expectedVersion: ExpectedVersion,
          },
          strict,
        ),
      },
    },
    async (req) => updateTask(db, actorOf(req), req.params.id, req.body as never),
  );

  r.post(
    '/tasks/:id/transitions',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            to: TaskStatusSchema,
            reason: Type.Optional(Type.String({ maxLength: 2000 })),
            expectedVersion: Type.Optional(ExpectedVersion),
          },
          strict,
        ),
      },
    },
    async (req) => {
      const { to, ...opts } = req.body;
      return transitionTask(db, actorOf(req), req.params.id, to as never, opts);
    },
  );

  r.get('/tasks/:id/history', { schema: { params: IdParams } }, async (req) => ({
    items: await getTaskHistory(db, actorOf(req), req.params.id),
  }));

  r.get('/tasks/:id/dependencies', { schema: { params: IdParams } }, async (req) => ({
    items: await listDependencies(db, actorOf(req), req.params.id),
  }));

  r.post(
    '/tasks/:id/dependencies',
    { schema: { params: IdParams, body: Type.Object({ dependsOnTaskId: Uuid }, strict) } },
    async (req, reply) => {
      await addDependency(db, actorOf(req), req.params.id, req.body.dependsOnTaskId);
      return reply.code(204).send();
    },
  );

  r.delete(
    '/tasks/:id/dependencies/:dependsOnTaskId',
    { schema: { params: Type.Object({ id: Uuid, dependsOnTaskId: Uuid }) } },
    async (req, reply) => {
      await removeDependency(db, actorOf(req), req.params.id, req.params.dependsOnTaskId);
      return reply.code(204).send();
    },
  );
}
