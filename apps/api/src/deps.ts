import type { Db } from '@platform/db';
import type { Logger } from '@platform/observability';
import type { StorageAdapter } from '@platform/storage';

export interface AppDeps {
  db: Db;
  storage: StorageAdapter;
  logger?: Logger;
  cookieSecure?: boolean;
  initGit?: boolean;
  rateLimitPerMinute?: number;
}
