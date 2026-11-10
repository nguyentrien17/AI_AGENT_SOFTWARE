import { hostname } from 'node:os';
import type { ProviderAdapterRegistry, SecretStore } from '@platform/ai-management';
import type { Db } from '@platform/db';
import { dispatchOutboxBatch, type Logger } from '@platform/observability';
import { createAgentTaskExecutor, runWorkerOnce } from '@platform/orchestration';
import { uuidv7 } from '@platform/shared';
import type { StorageAdapter } from '@platform/storage';
import type { ToolCatalog } from '@platform/tool-executor';
import { createBudgetHaltHandler } from './budget-halt.js';
import { createOutboxHandlers } from './outbox-handlers.js';

export interface WorkerOptions {
  db: Db;
  storage: StorageAdapter;
  secretStore: SecretStore;
  registry: ProviderAdapterRegistry;
  toolCatalog: ToolCatalog;
  logger: Logger;
  /** Pause between polls when there is no work. */
  idleMs?: number;
  leaseSeconds?: number;
}

/**
 * In-process scheduler worker (Phase 5). It shares the database with the API; leases make it safe to run
 * any number of these, in this process or others. A dedicated `apps/worker` process is a later step.
 */
export function startWorker(opts: WorkerOptions): { workerId: string; stop: () => Promise<void> } {
  const workerId = `${hostname()}:${process.pid}:${uuidv7().slice(-8)}`;
  const executor = createAgentTaskExecutor({
    db: opts.db,
    storage: opts.storage,
    secretStore: opts.secretStore,
    registry: opts.registry,
    onBudgetHalt: createBudgetHaltHandler(opts.db, opts.storage),
    tools: { storageRoot: opts.storage.root, catalog: opts.toolCatalog },
  });
  const outboxHandlers = createOutboxHandlers(opts.db, opts.storage);
  const idleMs = opts.idleMs ?? 2_000;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;

  const loop = async () => {
    if (stopped) return;
    let busy = false;
    try {
      const tick = await runWorkerOnce(
        { db: opts.db, executor, storage: opts.storage, ...(opts.leaseSeconds ? { leaseSeconds: opts.leaseSeconds } : {}) },
        workerId,
      );
      busy = tick.outcome !== 'idle';
      for (const r of tick.recovered) opts.logger.warn('lease recovered', { ...r });
      if (busy) {
        opts.logger.info('task processed', { workerId, taskId: tick.taskId, outcome: tick.outcome, error: tick.error });
      }
    } catch (err) {
      opts.logger.error('worker tick failed', { workerId, err });
    }
    try {
      const out = await dispatchOutboxBatch(opts.db, outboxHandlers);
      if (out.dispatched === 50) busy = true; // a full batch: more may be waiting
      if (out.failed) opts.logger.warn('outbox events failed permanently', { workerId, failed: out.failed });
    } catch (err) {
      opts.logger.error('outbox dispatch failed', { workerId, err });
    }
    if (!stopped) timer = setTimeout(() => (current = loop()), busy ? 0 : idleMs);
  };

  current = loop();
  opts.logger.info('worker started', { workerId });
  return {
    workerId,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
      opts.logger.info('worker stopped', { workerId });
    },
  };
}
