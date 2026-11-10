import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import { agents, type Db } from '@platform/db';
import { type Actor, ValidationError } from '@platform/shared';
import { type AgentDefinition, createAgent, publishAgentVersion } from './registry.js';
import { seedSkillLibrary } from './skills.js';

export interface AgentLibraryEntry {
  file: string;
  agentKey: string;
  name: string;
  description: string;
  role: string;
  definition: AgentDefinition;
}

function str(doc: Record<string, unknown>, key: string, file: string): string {
  const v = doc[key];
  if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${file}: '${key}' is required`);
  return v.trim();
}

/** Parses one agent definition document (snake_case keys, Blueprint §6.1 field names). */
export function parseAgentDocument(text: string, file: string): AgentLibraryEntry {
  const doc = parseYaml(text) as unknown;
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new ValidationError(`${file}: expected a YAML mapping`);
  }
  const d = doc as Record<string, unknown>;
  const definition: AgentDefinition = { systemInstruction: str(d, 'system_instruction', file) };
  if (d['input_schema'] !== undefined) definition.inputSchema = d['input_schema'] as Record<string, unknown>;
  if (d['output_schema'] !== undefined) definition.outputSchema = d['output_schema'] as Record<string, unknown>;
  if (d['allowed_tools'] !== undefined) definition.allowedTools = d['allowed_tools'] as string[];
  if (d['allowed_file_scopes'] !== undefined) definition.allowedFileScopes = d['allowed_file_scopes'] as string[];
  if (d['allowed_actions'] !== undefined) definition.allowedActions = d['allowed_actions'] as string[];
  if (typeof d['model_config_ref'] === 'string') definition.modelConfigRef = d['model_config_ref'];
  if (d['timeout_seconds'] !== undefined) definition.timeoutSeconds = d['timeout_seconds'] as number;
  if (d['completion_criteria'] !== undefined) definition.completionCriteria = d['completion_criteria'] as string[];
  if (d['skills'] !== undefined) definition.skills = d['skills'] as string[];
  const retry = d['retry_policy'] as Record<string, unknown> | undefined;
  if (retry?.['max_output_repairs'] !== undefined) {
    definition.retryPolicy = { maxOutputRepairs: retry['max_output_repairs'] as number };
  }
  return {
    file,
    agentKey: str(d, 'agent_key', file),
    name: str(d, 'name', file),
    description: typeof d['description'] === 'string' ? d['description'].trim() : '',
    role: str(d, 'role', file),
    definition,
  };
}

export async function loadAgentLibrary(dir: string): Promise<AgentLibraryEntry[]> {
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/i.test(f)).sort();
  const entries: AgentLibraryEntry[] = [];
  for (const file of files) {
    entries.push(parseAgentDocument(await readFile(path.join(dir, file), 'utf8'), file));
  }
  const keys = new Set<string>();
  for (const e of entries) {
    if (keys.has(e.agentKey)) throw new ValidationError(`Duplicate agent_key '${e.agentKey}' in agent library`);
    keys.add(e.agentKey);
  }
  return entries;
}

export interface SeedResult {
  agentKey: string;
  outcome: 'created' | 'new_version' | 'unchanged';
  versionNo: number;
}

/**
 * Registers the agent library in a workspace. Idempotent: an unchanged definition is left alone, a changed
 * one becomes a new immutable version (existing versions are never rewritten).
 */
export async function seedAgentLibrary(db: Db, actor: Actor, dir: string): Promise<SeedResult[]> {
  if (!actor.workspaceId) throw new ValidationError('A workspace context is required');
  // Skills first: agent definitions refer to them.
  await seedSkillLibrary(db, actor, dir);
  const results: SeedResult[] = [];
  for (const entry of await loadAgentLibrary(dir)) {
    const [existing] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, actor.workspaceId), eq(agents.agentKey, entry.agentKey)))
      .limit(1);
    if (!existing) {
      const created = await createAgent(db, actor, entry);
      results.push({ agentKey: entry.agentKey, outcome: 'created', versionNo: created.currentVersion!.versionNo });
      continue;
    }
    const { version, created } = await publishAgentVersion(db, actor, existing.id, entry.definition);
    results.push({
      agentKey: entry.agentKey,
      outcome: created ? 'new_version' : 'unchanged',
      versionNo: version.versionNo,
    });
  }
  return results;
}
