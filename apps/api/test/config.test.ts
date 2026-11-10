import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, REPO_ROOT } from '../src/config.js';

describe('API configuration', () => {
  it('resolves relative paths from the repository root, not the current directory', () => {
    const root = path.resolve('/srv/platform');
    const c = loadConfig({ DATABASE_URL: 'pglite://./data/pgdata', AGENT_LIBRARY_DIR: './agent-library' }, root);
    expect(c.databaseUrl).toBe(`pglite://${path.join(root, 'data', 'pgdata')}`);
    expect(c.agentLibraryDir).toBe(path.join(root, 'agent-library'));
    expect(c.storageRoot).toBe(path.join(root, 'data', 'storage'));
    expect(loadConfig({ DATABASE_URL: 'postgres://u@db/x' }, root).databaseUrl).toBe('postgres://u@db/x');
    expect(loadConfig({ DATABASE_URL: 'pglite://memory' }, root).databaseUrl).toBe('pglite://memory');
  });

  it('points at this repository by default', () => {
    expect(path.basename(loadConfig({}).agentLibraryDir)).toBe('agent-library');
    expect(loadConfig({}).agentLibraryDir.startsWith(REPO_ROOT)).toBe(true);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid PORT/);
  });
});
