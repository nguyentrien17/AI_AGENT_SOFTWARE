import { type Static, Type } from '@sinclair/typebox';
import { ROLES } from '@platform/iam';
import { taskStatusValues } from '@platform/db';

export const Uuid = Type.String({ format: 'uuid' });
export const IdParams = Type.Object({ id: Uuid });
export type IdParams = Static<typeof IdParams>;

export const RoleSchema = Type.Union(ROLES.map((r) => Type.Literal(r)));
export const TaskStatusSchema = Type.Union(taskStatusValues.map((s) => Type.Literal(s)));
export const RequirementStatusSchema = Type.Union(
  ['draft', 'in_review', 'approved', 'superseded'].map((s) => Type.Literal(s)),
);
export const PrioritySchema = Type.Union(['must', 'should', 'could', 'wont'].map((s) => Type.Literal(s)));
export const VerificationKindSchema = Type.Union(['test', 'review', 'manual'].map((s) => Type.Literal(s)));
export const ComplexitySchema = Type.Union(
  ['trivial', 'low', 'medium', 'high', 'critical'].map((s) => Type.Literal(s)),
);

export const ExpectedVersion = Type.Integer({ minimum: 1 });

export const PaginationQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const strict = { additionalProperties: false } as const;
