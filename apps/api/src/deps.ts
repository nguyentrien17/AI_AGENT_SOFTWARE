import type { ProviderAdapterRegistry, SecretStore } from '@platform/ai-management';
import type { Db } from '@platform/db';
import type { Logger } from '@platform/observability';
import type { StorageAdapter } from '@platform/storage';
import type { ToolCatalog } from '@platform/tool-executor';

export interface AppDeps {
  db: Db;
  storage: StorageAdapter;
  logger?: Logger;
  secretStore?: SecretStore;
  adapterRegistry?: ProviderAdapterRegistry;
  cookieSecure?: boolean;
  initGit?: boolean;
  rateLimitPerMinute?: number;
  /** Directory of versioned agent YAML definitions (`POST /agents/seed`). */
  agentLibraryDir?: string;
  /** Tools available to agents (defaults to the built-in catalog). */
  toolCatalog?: ToolCatalog;
  /** Extra browser origins allowed to change data (CSRF check). Loopback and same-origin are always allowed. */
  allowedOrigins?: string[];
}
