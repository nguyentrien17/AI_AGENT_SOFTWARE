import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import { tasks } from '@platform/db';
import { getArtifact, listArtifactVersions } from '@platform/artifacts';
import {
  addProjectMemory,
  archiveProjectMemory,
  buildContextPackage,
  createCheckpoint,
  getContextPackage,
  getHandoff,
  getLatestTaskPackage,
  getProjectContextIndex,
  listCheckpoints,
  listHandoffs,
  listProjectMemories,
  verifyCheckpoint,
} from '@platform/context';
import { NotFoundError, ValidationError } from '@platform/shared';
import { actorOf } from '../auth-plugin.js';
import type { AppDeps } from '../deps.js';
import { IdParams, strict, Uuid } from '../schemas.js';

const MemoryKind = Type.Union(['decision', 'fact', 'constraint', 'lesson'].map((k) => Type.Literal(k)));

export function contextRoutes(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const { db } = deps;
  const adeps = { db, storage: deps.storage };

  r.get('/projects/:id/context', { schema: { params: IdParams } }, async (req) =>
    getProjectContextIndex(db, actorOf(req), req.params.id),
  );

  r.get(
    '/projects/:id/context/:contextId',
    { schema: { params: Type.Object({ id: Uuid, contextId: Uuid }) } },
    async (req) => {
      const item = await getArtifact(adeps, actorOf(req), req.params.contextId);
      if (item.projectId !== req.params.id) throw new NotFoundError('Context item', req.params.contextId);
      return { item, versions: await listArtifactVersions(adeps, actorOf(req), item.id) };
    },
  );

  r.post(
    '/projects/:id/context/packages',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            taskId: Uuid,
            agentRole: Type.Optional(Type.String({ maxLength: 40 })),
            tokenBudget: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000_000 })),
          },
          strict,
        ),
      },
    },
    async (req, reply) => {
      const [task] = await db
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, req.body.taskId));
      if (!task || task.projectId !== req.params.id)
        throw new ValidationError('taskId does not belong to this project');
      const result = await buildContextPackage(adeps, actorOf(req), req.body);
      return reply.code(result.cacheHit ? 200 : 201).send(result);
    },
  );

  r.get('/tasks/:id/context', { schema: { params: IdParams } }, async (req) => {
    const pkg = await getLatestTaskPackage(db, actorOf(req), req.params.id);
    if (!pkg) throw new NotFoundError('Valid context package for task', req.params.id);
    return pkg;
  });

  r.get('/context-packages/:id', { schema: { params: IdParams } }, async (req) =>
    getContextPackage(db, actorOf(req), req.params.id),
  );

  // ------------------------------------------------------------ handoffs (emitted internally by agents)
  r.get(
    '/projects/:id/handoffs',
    { schema: { params: IdParams, querystring: Type.Object({ taskId: Type.Optional(Uuid) }) } },
    async (req) => ({ items: await listHandoffs(db, actorOf(req), req.params.id, req.query) }),
  );
  r.get('/agent-handoffs/:id', { schema: { params: IdParams } }, async (req) =>
    getHandoff(db, actorOf(req), req.params.id),
  );

  // ------------------------------------------------------------ memories
  r.get(
    '/projects/:id/memories',
    {
      schema: {
        params: IdParams,
        querystring: Type.Object({
          kind: Type.Optional(MemoryKind),
          includeArchived: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req) => ({
      items: await listProjectMemories(db, actorOf(req), req.params.id, req.query as never),
    }),
  );
  r.post(
    '/projects/:id/memories',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            kind: MemoryKind,
            content: Type.String({ minLength: 1, maxLength: 4000 }),
            sourceRef: Type.Optional(Type.String({ maxLength: 500 })),
          },
          strict,
        ),
      },
    },
    async (req, reply) =>
      reply.code(201).send(await addProjectMemory(db, actorOf(req), req.params.id, req.body as never)),
  );
  r.post('/memories/:id/archive', { schema: { params: IdParams } }, async (req) =>
    archiveProjectMemory(db, actorOf(req), req.params.id),
  );

  // ------------------------------------------------------------ checkpoints
  r.get('/projects/:id/checkpoints', { schema: { params: IdParams } }, async (req) => ({
    items: await listCheckpoints(db, actorOf(req), req.params.id),
  }));
  r.post(
    '/projects/:id/checkpoints',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          { label: Type.String({ minLength: 1, maxLength: 200 }), taskId: Type.Optional(Uuid) },
          strict,
        ),
      },
    },
    async (req, reply) =>
      reply.code(201).send(await createCheckpoint(adeps, actorOf(req), req.params.id, req.body)),
  );
  r.get('/checkpoints/:id', { schema: { params: IdParams } }, async (req) =>
    verifyCheckpoint(adeps, actorOf(req), req.params.id),
  );
}
