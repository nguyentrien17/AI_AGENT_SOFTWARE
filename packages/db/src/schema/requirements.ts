import { index, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt, version } from './columns.js';
import { projects } from './projects.js';

export const requirementStatus = pgEnum('requirement_status', [
  'draft',
  'in_review',
  'approved',
  'superseded',
]);
export const storyPriority = pgEnum('story_priority', ['must', 'should', 'could', 'wont']);
export const verificationKind = pgEnum('verification_kind', ['test', 'review', 'manual']);

export const requirements = pgTable(
  'requirements',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    status: requirementStatus('status').notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('requirements_project_code_uq').on(t.projectId, t.code)],
);

export const userStories = pgTable(
  'user_stories',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requirementId: uuid('requirement_id').references(() => requirements.id, { onDelete: 'set null' }),
    code: text('code').notNull(),
    asA: text('as_a').notNull(),
    iWant: text('i_want').notNull(),
    soThat: text('so_that').notNull().default(''),
    priority: storyPriority('priority').notNull().default('should'),
    status: requirementStatus('status').notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('user_stories_project_code_uq').on(t.projectId, t.code),
    index('user_stories_requirement_idx').on(t.requirementId),
  ],
);

export const acceptanceCriteria = pgTable(
  'acceptance_criteria',
  {
    id: id(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => userStories.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    given: text('given').notNull().default(''),
    when: text('when').notNull().default(''),
    then: text('then').notNull(),
    verificationKind: verificationKind('verification_kind').notNull().default('test'),
    status: requirementStatus('status').notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('acceptance_criteria_story_code_uq').on(t.storyId, t.code)],
);
