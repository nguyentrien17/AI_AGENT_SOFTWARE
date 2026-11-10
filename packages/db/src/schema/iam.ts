import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt, version } from './columns.js';

export const workspaceRole = pgEnum('workspace_role', [
  'owner',
  'administrator',
  'project_manager',
  'developer',
  'reviewer',
  'viewer',
]);

export const userStatus = pgEnum('user_status', ['active', 'disabled']);

export const workspaces = pgTable('workspaces', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  status: userStatus('status').notNull().default('active'),
  isPlatformOwner: boolean('is_platform_owner').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('workspace_members_ws_user_uq').on(t.workspaceId, t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: id(),
    key: text('key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: jsonb('response_status').$type<number>(),
    responseBody: jsonb('response_body'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('idempotency_keys_key_user_uq').on(t.key, t.userId)],
);
