import {
  bigint,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt, version } from './columns.js';
import { users } from './iam.js';
import { projects } from './projects.js';

export const artifactStatus = pgEnum('artifact_status', ['draft', 'approved', 'superseded']);

/**
 * Head record for a versioned project artifact (Blueprint §13.6 `context_items`).
 * Content lives in File Storage (content-addressed blob + working copy); DB holds metadata and hashes.
 */
export const contextItems = pgTable(
  'context_items',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    type: text('type').notNull(),
    ownerRole: text('owner_role'),
    currentVersionNo: integer('current_version_no').notNull().default(0),
    approvedVersionNo: integer('approved_version_no'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('context_items_project_path_uq').on(t.projectId, t.path)],
);

/** Immutable artifact versions (append-only). */
export const contextVersions = pgTable(
  'context_versions',
  {
    id: id(),
    contextItemId: uuid('context_item_id')
      .notNull()
      .references(() => contextItems.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storageUri: text('storage_uri').notNull(),
    status: artifactStatus('status').notNull().default('draft'),
    authorType: text('author_type').notNull(),
    authorId: text('author_id').notNull(),
    changeNote: text('change_note').notNull().default(''),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('context_versions_item_version_uq').on(t.contextItemId, t.versionNo),
    index('context_versions_sha_idx').on(t.sha256),
  ],
);
