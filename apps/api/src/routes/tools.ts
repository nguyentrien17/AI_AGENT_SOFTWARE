import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { authorize } from '@platform/iam';
import { getTask, getTaskLineage } from '@platform/orchestration';
import { NotFoundError } from '@platform/shared';
import { createDefaultToolCatalog, describeTool, getTaskWorkspaceDiff, listToolExecutions } from '@platform/tool-executor';
import { actorOf } from '../auth-plugin.js';
import type { AppDeps } from '../deps.js';
import { IdParams } from '../schemas.js';

/** Phase 6 (part A) HTTP surface: tool catalog, per-task tool call log, task workspace diff. */
export function toolRoutes(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const { db } = deps;
  const catalog = deps.toolCatalog ?? createDefaultToolCatalog();

  r.get('/tools', async (req) => {
    await authorize(db, actorOf(req), 'ai.config.read');
    return { items: catalog.list().map(describeTool) };
  });

  r.get('/tasks/:id/tool-executions', { schema: { params: IdParams } }, async (req) => {
    const task = await getTask(db, actorOf(req), req.params.id); // authorizes task.read
    return { items: await listToolExecutions(db, task.id) };
  });

  r.get('/tasks/:id/lineage', { schema: { params: IdParams } }, async (req) =>
    getTaskLineage(db, actorOf(req), req.params.id, { storageRoot: deps.storage.root }),
  );

  r.get('/tasks/:id/workspace/diff', { schema: { params: IdParams } }, async (req) => {
    const task = await getTask(db, actorOf(req), req.params.id);
    const diff = await getTaskWorkspaceDiff(db, deps.storage.root, task.id);
    if (!diff) throw new NotFoundError('Task workspace', task.id);
    return diff;
  });
}
