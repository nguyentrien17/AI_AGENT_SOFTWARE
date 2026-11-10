import { and, asc, count, eq } from 'drizzle-orm';
import { acceptanceCriteria, type Db, requirements, userStories } from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import {
  type Actor,
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '@platform/shared';

export type RequirementStatus = 'draft' | 'in_review' | 'approved' | 'superseded';

/** Lifecycle shared by requirements, user stories and acceptance criteria. */
const TRANSITIONS: Record<RequirementStatus, RequirementStatus[]> = {
  draft: ['in_review', 'superseded'],
  in_review: ['draft', 'approved', 'superseded'],
  approved: ['superseded'],
  superseded: [],
};

export function assertRequirementTransition(entity: string, from: RequirementStatus, to: RequirementStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidStateTransitionError(entity, from, to);
}

function requireText(v: string | undefined, field: string): string {
  const t = v?.trim() ?? '';
  if (!t) throw new ValidationError(`${field} is required`, [{ path: field, message: 'required' }]);
  return t;
}

function assertEditable(entity: string, status: RequirementStatus) {
  if (status === 'approved' || status === 'superseded') {
    throw new ConflictError(`${entity} is ${status} and immutable; supersede it and create a new one`, 'approved_immutable');
  }
}

async function nextCode(db: Db, table: typeof requirements | typeof userStories, projectId: string, prefix: string) {
  const [r] = await db.select({ n: count() }).from(table).where(eq(table.projectId, projectId));
  return `${prefix}-${String((r?.n ?? 0) + 1).padStart(3, '0')}`;
}

// ---------------------------------------------------------------- requirements

export async function createRequirement(
  db: Db,
  actor: Actor,
  projectId: string,
  input: { code?: string; title: string; body?: string },
) {
  await authorize(db, actor, 'requirement.write', { projectId });
  const title = requireText(input.title, 'title');
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const code = input.code?.trim() || (await nextCode(tx, requirements, projectId, 'REQ'));
    const [dup] = await tx.select({ id: requirements.id }).from(requirements).where(and(eq(requirements.projectId, projectId), eq(requirements.code, code)));
    if (dup) throw new ConflictError(`Requirement code '${code}' already exists`, 'code_taken');
    const [r] = await tx.insert(requirements).values({ projectId, code, title, body: input.body ?? '' }).returning();
    await audit(tx, actor, { action: 'requirement.create', targetType: 'requirement', targetId: r!.id, projectId, payload: { code } });
    return r!;
  });
}

export async function listRequirements(db: Db, actor: Actor, projectId: string) {
  await authorize(db, actor, 'requirement.read', { projectId });
  return db.select().from(requirements).where(eq(requirements.projectId, projectId)).orderBy(asc(requirements.code));
}

async function loadRequirement(db: Db, id: string) {
  const [r] = await db.select().from(requirements).where(eq(requirements.id, id)).limit(1);
  if (!r) throw new NotFoundError('Requirement', id);
  return r;
}

export async function getRequirement(db: Db, actor: Actor, id: string) {
  const r = await loadRequirement(db, id);
  await authorize(db, actor, 'requirement.read', { projectId: r.projectId });
  return r;
}

export async function updateRequirement(
  db: Db,
  actor: Actor,
  id: string,
  input: { title?: string; body?: string; expectedVersion: number },
) {
  const cur = await loadRequirement(db, id);
  await authorize(db, actor, 'requirement.write', { projectId: cur.projectId });
  assertEditable('Requirement', cur.status);
  const patch: Partial<typeof requirements.$inferInsert> = { version: input.expectedVersion + 1 };
  if (input.title !== undefined) patch.title = requireText(input.title, 'title');
  if (input.body !== undefined) patch.body = input.body;
  const [r] = await db
    .update(requirements)
    .set(patch)
    .where(and(eq(requirements.id, id), eq(requirements.version, input.expectedVersion)))
    .returning();
  if (!r) throw new VersionConflictError('Requirement', input.expectedVersion, cur.version);
  await audit(db, actor, { action: 'requirement.update', targetType: 'requirement', targetId: id, projectId: cur.projectId });
  return r;
}

export async function transitionRequirement(db: Db, actor: Actor, id: string, to: RequirementStatus, expectedVersion: number) {
  const cur = await loadRequirement(db, id);
  await authorize(db, actor, to === 'approved' ? 'requirement.approve' : 'requirement.write', { projectId: cur.projectId });
  assertRequirementTransition('Requirement', cur.status, to);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [r] = await tx
      .update(requirements)
      .set({ status: to, version: expectedVersion + 1 })
      .where(and(eq(requirements.id, id), eq(requirements.version, expectedVersion)))
      .returning();
    if (!r) throw new VersionConflictError('Requirement', expectedVersion, cur.version);
    await audit(tx, actor, { action: `requirement.${to}`, targetType: 'requirement', targetId: id, projectId: cur.projectId, payload: { from: cur.status, to } });
    if (to === 'approved') {
      await emitEvent(tx, { type: 'requirement.approved', aggregateType: 'requirement', aggregateId: id, workspaceId: actor.workspaceId, projectId: cur.projectId });
    }
    return r;
  });
}

// ---------------------------------------------------------------- user stories

export async function createUserStory(
  db: Db,
  actor: Actor,
  projectId: string,
  input: { requirementId?: string | null; code?: string; asA: string; iWant: string; soThat?: string; priority?: 'must' | 'should' | 'could' | 'wont' },
) {
  await authorize(db, actor, 'requirement.write', { projectId });
  if (input.requirementId) {
    const req = await loadRequirement(db, input.requirementId);
    if (req.projectId !== projectId) throw new ValidationError('Requirement belongs to another project');
  }
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const code = input.code?.trim() || (await nextCode(tx, userStories, projectId, 'US'));
    const [dup] = await tx.select({ id: userStories.id }).from(userStories).where(and(eq(userStories.projectId, projectId), eq(userStories.code, code)));
    if (dup) throw new ConflictError(`User story code '${code}' already exists`, 'code_taken');
    const [s] = await tx
      .insert(userStories)
      .values({
        projectId,
        requirementId: input.requirementId ?? null,
        code,
        asA: requireText(input.asA, 'asA'),
        iWant: requireText(input.iWant, 'iWant'),
        soThat: input.soThat ?? '',
        priority: input.priority ?? 'should',
      })
      .returning();
    await audit(tx, actor, { action: 'user_story.create', targetType: 'user_story', targetId: s!.id, projectId, payload: { code } });
    return s!;
  });
}

export async function listUserStories(db: Db, actor: Actor, projectId: string) {
  await authorize(db, actor, 'requirement.read', { projectId });
  return db.select().from(userStories).where(eq(userStories.projectId, projectId)).orderBy(asc(userStories.code));
}

async function loadStory(db: Db, id: string) {
  const [s] = await db.select().from(userStories).where(eq(userStories.id, id)).limit(1);
  if (!s) throw new NotFoundError('User story', id);
  return s;
}

export async function updateUserStory(
  db: Db,
  actor: Actor,
  id: string,
  input: { asA?: string; iWant?: string; soThat?: string; priority?: 'must' | 'should' | 'could' | 'wont'; expectedVersion: number },
) {
  const cur = await loadStory(db, id);
  await authorize(db, actor, 'requirement.write', { projectId: cur.projectId });
  assertEditable('User story', cur.status);
  const patch: Partial<typeof userStories.$inferInsert> = { version: input.expectedVersion + 1 };
  if (input.asA !== undefined) patch.asA = requireText(input.asA, 'asA');
  if (input.iWant !== undefined) patch.iWant = requireText(input.iWant, 'iWant');
  if (input.soThat !== undefined) patch.soThat = input.soThat;
  if (input.priority !== undefined) patch.priority = input.priority;
  const [s] = await db
    .update(userStories)
    .set(patch)
    .where(and(eq(userStories.id, id), eq(userStories.version, input.expectedVersion)))
    .returning();
  if (!s) throw new VersionConflictError('User story', input.expectedVersion, cur.version);
  await audit(db, actor, { action: 'user_story.update', targetType: 'user_story', targetId: id, projectId: cur.projectId });
  return s;
}

export async function transitionUserStory(db: Db, actor: Actor, id: string, to: RequirementStatus, expectedVersion: number) {
  const cur = await loadStory(db, id);
  await authorize(db, actor, to === 'approved' ? 'requirement.approve' : 'requirement.write', { projectId: cur.projectId });
  assertRequirementTransition('User story', cur.status, to);
  const [s] = await db
    .update(userStories)
    .set({ status: to, version: expectedVersion + 1 })
    .where(and(eq(userStories.id, id), eq(userStories.version, expectedVersion)))
    .returning();
  if (!s) throw new VersionConflictError('User story', expectedVersion, cur.version);
  await audit(db, actor, { action: `user_story.${to}`, targetType: 'user_story', targetId: id, projectId: cur.projectId, payload: { from: cur.status, to } });
  return s;
}

// ---------------------------------------------------------------- acceptance criteria

export async function createAcceptanceCriterion(
  db: Db,
  actor: Actor,
  storyId: string,
  input: { code?: string; given?: string; when?: string; then: string; verificationKind?: 'test' | 'review' | 'manual' },
) {
  const story = await loadStory(db, storyId);
  await authorize(db, actor, 'requirement.write', { projectId: story.projectId });
  assertEditable('User story', story.status);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [n] = await tx.select({ n: count() }).from(acceptanceCriteria).where(eq(acceptanceCriteria.storyId, storyId));
    const code = input.code?.trim() || `${story.code}-AC${(n?.n ?? 0) + 1}`;
    const [dup] = await tx.select({ id: acceptanceCriteria.id }).from(acceptanceCriteria).where(and(eq(acceptanceCriteria.storyId, storyId), eq(acceptanceCriteria.code, code)));
    if (dup) throw new ConflictError(`Acceptance criterion code '${code}' already exists`, 'code_taken');
    const [ac] = await tx
      .insert(acceptanceCriteria)
      .values({
        storyId,
        code,
        given: input.given ?? '',
        when: input.when ?? '',
        then: requireText(input.then, 'then'),
        verificationKind: input.verificationKind ?? 'test',
      })
      .returning();
    await audit(tx, actor, { action: 'acceptance_criterion.create', targetType: 'acceptance_criterion', targetId: ac!.id, projectId: story.projectId, payload: { code } });
    return ac!;
  });
}

export async function listAcceptanceCriteria(db: Db, actor: Actor, storyId: string) {
  const story = await loadStory(db, storyId);
  await authorize(db, actor, 'requirement.read', { projectId: story.projectId });
  return db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.storyId, storyId)).orderBy(asc(acceptanceCriteria.code));
}

export async function updateAcceptanceCriterion(
  db: Db,
  actor: Actor,
  id: string,
  input: { given?: string; when?: string; then?: string; verificationKind?: 'test' | 'review' | 'manual'; expectedVersion: number },
) {
  const [cur] = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.id, id)).limit(1);
  if (!cur) throw new NotFoundError('Acceptance criterion', id);
  const story = await loadStory(db, cur.storyId);
  await authorize(db, actor, 'requirement.write', { projectId: story.projectId });
  assertEditable('Acceptance criterion', cur.status);
  const patch: Partial<typeof acceptanceCriteria.$inferInsert> = { version: input.expectedVersion + 1 };
  if (input.given !== undefined) patch.given = input.given;
  if (input.when !== undefined) patch.when = input.when;
  if (input.then !== undefined) patch.then = requireText(input.then, 'then');
  if (input.verificationKind !== undefined) patch.verificationKind = input.verificationKind;
  const [ac] = await db
    .update(acceptanceCriteria)
    .set(patch)
    .where(and(eq(acceptanceCriteria.id, id), eq(acceptanceCriteria.version, input.expectedVersion)))
    .returning();
  if (!ac) throw new VersionConflictError('Acceptance criterion', input.expectedVersion, cur.version);
  await audit(db, actor, { action: 'acceptance_criterion.update', targetType: 'acceptance_criterion', targetId: id, projectId: story.projectId });
  return ac;
}
