import { index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt, version } from './columns.js';
import { users, workspaceRole, workspaces } from './iam.js';

export const projectStatus = pgEnum('project_status', ['active', 'archived']);

export const projects = pgTable(
  'projects',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: projectStatus('status').notNull().default('active'),
    currentStage: text('current_stage').notNull().default('intake'),
    storagePath: text('storage_path').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('projects_ws_key_uq').on(t.workspaceId, t.key),
    index('projects_ws_status_idx').on(t.workspaceId, t.status, t.createdAt),
  ],
);

export const projectMembers = pgTable(
  'project_members',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('project_members_project_user_uq').on(t.projectId, t.userId)],
);

export const projectSettings = pgTable('project_settings', {
  id: id(),
  projectId: uuid('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  configVersion: integer('config_version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const repositories = pgTable('repositories', {
  id: id(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('git'),
  localPath: text('local_path').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  integrationBranch: text('integration_branch').notNull().default('integration'),
  remoteUrl: text('remote_url'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const projectEnvironments = pgTable(
  'project_environments',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    runtime: text('runtime').notNull(),
    image: text('image'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('project_environments_project_name_uq').on(t.projectId, t.name)],
);
