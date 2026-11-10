import type { ProviderAdapterRegistry, SecretStore } from '@platform/ai-management';
import type { Db } from '@platform/db';
import type { Logger } from '@platform/observability';
import type { StorageAdapter } from '@platform/storage';

export interface AppDeps {
  db: Db;
  storage: StorageAdapter;
  logger?: Logger;
  secretStore?: SecretStore;
  adapterRegistry?: ProviderAdapterRegistry;
  cookieSecure?: boolean;
  initGit?: boolean;
  rateLimitPerMinute?: number;
}
