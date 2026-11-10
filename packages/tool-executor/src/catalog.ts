import { sql } from 'drizzle-orm';
import { type Db, toolRegistry } from '@platform/db';
import { ConflictError, hashJson, ValidationError } from '@platform/shared';
import { fsDeleteFile, fsListDir, fsReadFile, fsWriteFile } from './tools/fs.js';
import { gitCheckMergeTool, gitCommitTool, gitDiffTool, gitLogTool, gitStatusTool } from './tools/git.js';
import type { AnyToolDefinition } from './types.js';

const KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;

/** In-process tool registry (P6-01). Tools are code; the database row is the published catalog entry. */
export class ToolCatalog {
  private readonly tools = new Map<string, AnyToolDefinition>();

  constructor(tools: Iterable<AnyToolDefinition>) {
    for (const t of tools) {
      if (!KEY_RE.test(t.toolKey)) throw new ValidationError(`Invalid tool key '${t.toolKey}'`);
      if (this.tools.has(t.toolKey)) throw new ConflictError(`Duplicate tool '${t.toolKey}'`, 'tool_exists');
      this.tools.set(t.toolKey, t);
    }
  }

  get(toolKey: string): AnyToolDefinition | undefined {
    return this.tools.get(toolKey);
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.toolKey.localeCompare(b.toolKey));
  }
}

/** Built-in tools that need no sandbox. Terminal / test-runner tools arrive with the sandbox (Phase 6 part B). */
export function createDefaultToolCatalog(): ToolCatalog {
  return new ToolCatalog([
    fsReadFile,
    fsListDir,
    fsWriteFile,
    fsDeleteFile,
    gitStatusTool,
    gitDiffTool,
    gitCommitTool,
    gitLogTool,
    gitCheckMergeTool,
  ]);
}

export function describeTool(t: AnyToolDefinition) {
  return {
    toolKey: t.toolKey,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    action: t.action,
    requiredScopes: t.requiredScopes,
    timeoutSeconds: t.timeoutSeconds,
    risk: t.risk,
    idempotent: t.idempotent,
    requiresSandbox: t.requiresSandbox,
    redactionPolicy: t.redaction,
    runtimes: t.runtimes,
  };
}

/** Publishes the catalog to `tool_registry` (idempotent; changed definitions are updated in place). */
export async function syncToolRegistry(db: Db, catalog: ToolCatalog): Promise<number> {
  for (const t of catalog.list()) {
    const row = { ...describeTool(t), definitionHash: hashJson(describeTool(t)) };
    await db
      .insert(toolRegistry)
      .values(row)
      .onConflictDoUpdate({
        target: toolRegistry.toolKey,
        set: { ...row, updatedAt: new Date() },
        where: sql`${toolRegistry.definitionHash} <> ${row.definitionHash}`,
      });
  }
  return catalog.list().length;
}
