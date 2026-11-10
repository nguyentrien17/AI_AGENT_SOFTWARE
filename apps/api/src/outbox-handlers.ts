import { syncContextMap } from '@platform/artifacts';
import type { Db } from '@platform/db';
import type { OutboxHandler } from '@platform/observability';
import type { StorageAdapter } from '@platform/storage';

/**
 * Asynchronous consumers of domain events. Each handler is idempotent (events can be re-delivered).
 * - Artifact changes re-sync `.ai-context/00-index/context-map.json` from the database (Phase 2 risk R6):
 *   the synchronous write after a commit can race with a concurrent writer; this pass always ends with
 *   the map matching the authoritative database state.
 */
export function createOutboxHandlers(db: Db, storage: StorageAdapter): Record<string, OutboxHandler[]> {
  const resyncContextMap: OutboxHandler = async (event) => {
    if (event.projectId) await syncContextMap({ db, storage }, event.projectId);
  };
  return {
    'artifact.created': [resyncContextMap],
    'artifact.versioned': [resyncContextMap],
    'artifact.approved': [resyncContextMap],
  };
}
