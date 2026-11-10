import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import { type Db, workflows } from '@platform/db';
import { type Actor, ValidationError } from '@platform/shared';
import { createWorkflow, publishWorkflowVersion, validateWorkflowDefinition } from './workflows.js';

export interface WorkflowSeedResult {
  key: string;
  outcome: 'created' | 'new_version' | 'unchanged';
  versionNo: number;
}

/**
 * Registers the versioned workflow definitions in `<libraryDir>/workflows/*.yaml` (P7-07). Idempotent:
 * unchanged definitions are left alone, changed ones become a new immutable version.
 */
export async function seedWorkflowLibrary(db: Db, actor: Actor, libraryDir: string): Promise<WorkflowSeedResult[]> {
  if (!actor.workspaceId) throw new ValidationError('A workspace context is required');
  const dir = path.join(libraryDir, 'workflows');
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /\.ya?ml$/i.test(f)).sort();
  const results: WorkflowSeedResult[] = [];
  for (const file of files) {
    const doc = parseYaml(await readFile(path.join(dir, file), 'utf8')) as Record<string, unknown> | null;
    const key = typeof doc?.['key'] === 'string' ? doc['key'] : '';
    const name = typeof doc?.['name'] === 'string' ? doc['name'] : '';
    if (!key || !name) throw new ValidationError(`${file}: 'key' and 'name' are required`);
    const definition = validateWorkflowDefinition(doc!['definition']);
    const description = typeof doc!['description'] === 'string' ? doc!['description'].trim() : '';
    const [existing] = await db
      .select()
      .from(workflows)
      .where(and(eq(workflows.workspaceId, actor.workspaceId), eq(workflows.key, key)))
      .limit(1);
    if (!existing) {
      const created = await createWorkflow(db, actor, { key, name, description, definition });
      results.push({ key, outcome: 'created', versionNo: created.version.versionNo });
      continue;
    }
    const before = existing.currentVersionId;
    const version = await publishWorkflowVersion(db, actor, existing.id, definition);
    results.push({ key, outcome: version.id === before ? 'unchanged' : 'new_version', versionNo: version.versionNo });
  }
  return results;
}
