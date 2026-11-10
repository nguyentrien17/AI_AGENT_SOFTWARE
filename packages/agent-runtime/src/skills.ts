import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import { agentSkills, type Db } from '@platform/db';
import { authorize } from '@platform/iam';
import { audit } from '@platform/observability';
import { type Actor, actorId, ForbiddenError, hashJson, ValidationError } from '@platform/shared';

export type AgentSkill = typeof agentSkills.$inferSelect;

export const SKILL_KEY_RE = /^[a-z][a-z0-9_-]{1,59}$/;

export interface SkillDefinition {
  skillKey: string;
  name: string;
  description?: string;
  instructions: string;
}

function workspaceOf(actor: Actor): string {
  if (!actor.workspaceId) throw new ValidationError('A workspace context is required');
  return actor.workspaceId;
}

/**
 * Publishes a skill version (Blueprint §6.3). Identical content is a no-op; changed content becomes a new
 * immutable version. Administrators only, like agent definitions.
 */
export async function publishSkill(db: Db, actor: Actor, def: SkillDefinition): Promise<{ skill: AgentSkill; created: boolean }> {
  const { role } = await authorize(db, actor, 'ai.config.manage');
  if (role !== 'owner' && role !== 'administrator' && role !== 'system') {
    throw new ForbiddenError('Skills can only be changed by workspace administrators');
  }
  const workspaceId = workspaceOf(actor);
  const skillKey = def.skillKey.trim();
  if (!SKILL_KEY_RE.test(skillKey)) throw new ValidationError(`Invalid skill key '${def.skillKey}'`);
  const body = { name: def.name.trim(), description: (def.description ?? '').trim(), instructions: def.instructions.trim() };
  if (!body.name || !body.instructions) throw new ValidationError(`Skill '${skillKey}' needs a name and instructions`);
  const contentHash = hashJson(body);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [latest] = await tx
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.workspaceId, workspaceId), eq(agentSkills.skillKey, skillKey)))
      .orderBy(desc(agentSkills.versionNo))
      .limit(1);
    if (latest?.contentHash === contentHash) return { skill: latest, created: false };
    const [skill] = await tx
      .insert(agentSkills)
      .values({ workspaceId, skillKey, versionNo: (latest?.versionNo ?? 0) + 1, ...body, contentHash, createdBy: actorId(actor) })
      .returning();
    await audit(tx, actor, {
      action: 'agent.skill_published',
      targetType: 'agent_skill',
      targetId: skill!.id,
      payload: { skillKey, versionNo: skill!.versionNo },
    });
    return { skill: skill!, created: true };
  });
}

/** Latest version of each requested skill; unknown keys are reported, not ignored. Internal. */
export async function resolveSkills(db: Db, workspaceId: string, keys: readonly string[]): Promise<{ skills: AgentSkill[]; missing: string[] }> {
  if (keys.length === 0) return { skills: [], missing: [] };
  const rows = await db
    .select()
    .from(agentSkills)
    .where(and(eq(agentSkills.workspaceId, workspaceId), inArray(agentSkills.skillKey, [...keys])))
    .orderBy(desc(agentSkills.versionNo));
  const latest = new Map<string, AgentSkill>();
  for (const r of rows) if (!latest.has(r.skillKey)) latest.set(r.skillKey, r);
  return {
    skills: keys.map((k) => latest.get(k)).filter((s): s is AgentSkill => s !== undefined),
    missing: keys.filter((k) => !latest.has(k)),
  };
}

export async function listSkills(db: Db, actor: Actor): Promise<AgentSkill[]> {
  await authorize(db, actor, 'ai.config.read');
  const rows = await db
    .select()
    .from(agentSkills)
    .where(eq(agentSkills.workspaceId, workspaceOf(actor)))
    .orderBy(agentSkills.skillKey, desc(agentSkills.versionNo));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.skillKey) ? false : (seen.add(r.skillKey), true)));
}

/** Seeds `<libraryDir>/skills/*.yaml` (keys: skill_key, name, description, instructions). Idempotent. */
export async function seedSkillLibrary(
  db: Db,
  actor: Actor,
  libraryDir: string,
): Promise<Array<{ skillKey: string; outcome: 'created' | 'unchanged'; versionNo: number }>> {
  const dir = path.join(libraryDir, 'skills');
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /\.ya?ml$/i.test(f)).sort();
  const out: Array<{ skillKey: string; outcome: 'created' | 'unchanged'; versionNo: number }> = [];
  for (const file of files) {
    const doc = parseYaml(await readFile(path.join(dir, file), 'utf8')) as Record<string, unknown> | null;
    const get = (k: string) => (typeof doc?.[k] === 'string' ? (doc[k] as string) : '');
    if (!get('skill_key') || !get('name') || !get('instructions')) {
      throw new ValidationError(`${file}: skill_key, name and instructions are required`);
    }
    const { skill, created } = await publishSkill(db, actor, {
      skillKey: get('skill_key'),
      name: get('name'),
      description: get('description'),
      instructions: get('instructions'),
    });
    out.push({ skillKey: skill.skillKey, outcome: created ? 'created' : 'unchanged', versionNo: skill.versionNo });
  }
  return out;
}
