import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  createAcceptanceCriterion,
  createProject,
  createRequirement,
  createUserStory,
  getProject,
  getProjectSettings,
  getRequirement,
  listAcceptanceCriteria,
  listProjectMembers,
  listProjects,
  listRequirements,
  listUserStories,
  removeProjectMember,
  setProjectArchived,
  transitionRequirement,
  transitionUserStory,
  updateAcceptanceCriterion,
  updateProject,
  updateProjectSettings,
  updateRequirement,
  updateUserStory,
  upsertProjectMember,
} from '@platform/projects';
import { actorOf } from '../auth-plugin.js';
import type { AppDeps } from '../deps.js';
import {
  ExpectedVersion,
  IdParams,
  PrioritySchema,
  RequirementStatusSchema,
  RoleSchema,
  strict,
  Uuid,
  VerificationKindSchema,
} from '../schemas.js';

export function projectRoutes(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const { db } = deps;
  const pdeps = { db, storage: deps.storage, initGit: deps.initGit };

  r.get(
    '/projects',
    {
      schema: {
        querystring: Type.Object({
          status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('archived')])),
        }),
      },
    },
    async (req) => ({ items: await listProjects(pdeps, actorOf(req), req.query) }),
  );

  r.post(
    '/projects',
    {
      schema: {
        body: Type.Object(
          {
            key: Type.String({ maxLength: 40 }),
            name: Type.String({ minLength: 1, maxLength: 120 }),
            description: Type.Optional(Type.String({ maxLength: 4000 })),
          },
          strict,
        ),
      },
    },
    async (req, reply) => reply.code(201).send(await createProject(pdeps, actorOf(req), req.body)),
  );

  r.get('/projects/:id', { schema: { params: IdParams } }, async (req) =>
    getProject(pdeps, actorOf(req), req.params.id),
  );

  r.put(
    '/projects/:id',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            description: Type.Optional(Type.String({ maxLength: 4000 })),
            expectedVersion: ExpectedVersion,
          },
          strict,
        ),
      },
    },
    async (req) => updateProject(pdeps, actorOf(req), req.params.id, req.body),
  );

  r.post('/projects/:id/archive', { schema: { params: IdParams } }, async (req) =>
    setProjectArchived(pdeps, actorOf(req), req.params.id, true),
  );
  r.post('/projects/:id/restore', { schema: { params: IdParams } }, async (req) =>
    setProjectArchived(pdeps, actorOf(req), req.params.id, false),
  );

  r.get('/projects/:id/members', { schema: { params: IdParams } }, async (req) => ({
    items: await listProjectMembers(pdeps, actorOf(req), req.params.id),
  }));

  r.put(
    '/projects/:id/members',
    { schema: { params: IdParams, body: Type.Object({ userId: Uuid, role: RoleSchema }, strict) } },
    async (req, reply) => {
      await upsertProjectMember(pdeps, actorOf(req), req.params.id, req.body as never);
      return reply.code(204).send();
    },
  );

  r.delete(
    '/projects/:id/members/:userId',
    { schema: { params: Type.Object({ id: Uuid, userId: Uuid }) } },
    async (req, reply) => {
      await removeProjectMember(pdeps, actorOf(req), req.params.id, req.params.userId);
      return reply.code(204).send();
    },
  );

  r.get('/projects/:id/settings', { schema: { params: IdParams } }, async (req) =>
    getProjectSettings(pdeps, actorOf(req), req.params.id),
  );

  r.put(
    '/projects/:id/settings',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          { settings: Type.Record(Type.String(), Type.Unknown()), expectedVersion: ExpectedVersion },
          strict,
        ),
      },
    },
    async (req) => updateProjectSettings(pdeps, actorOf(req), req.params.id, req.body),
  );

  // ------------------------------------------------------------ requirements
  r.get('/projects/:id/requirements', { schema: { params: IdParams } }, async (req) => ({
    items: await listRequirements(db, actorOf(req), req.params.id),
  }));

  r.post(
    '/projects/:id/requirements',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            code: Type.Optional(Type.String({ maxLength: 40 })),
            title: Type.String({ minLength: 1, maxLength: 300 }),
            body: Type.Optional(Type.String({ maxLength: 100_000 })),
          },
          strict,
        ),
      },
    },
    async (req, reply) =>
      reply.code(201).send(await createRequirement(db, actorOf(req), req.params.id, req.body)),
  );

  r.get('/requirements/:id', { schema: { params: IdParams } }, async (req) =>
    getRequirement(db, actorOf(req), req.params.id),
  );

  r.put(
    '/requirements/:id',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
            body: Type.Optional(Type.String({ maxLength: 100_000 })),
            expectedVersion: ExpectedVersion,
          },
          strict,
        ),
      },
    },
    async (req) => updateRequirement(db, actorOf(req), req.params.id, req.body),
  );

  r.post(
    '/requirements/:id/transitions',
    {
      schema: {
        params: IdParams,
        body: Type.Object({ to: RequirementStatusSchema, expectedVersion: ExpectedVersion }, strict),
      },
    },
    async (req) =>
      transitionRequirement(db, actorOf(req), req.params.id, req.body.to as never, req.body.expectedVersion),
  );

  // ------------------------------------------------------------ user stories
  r.get('/projects/:id/user-stories', { schema: { params: IdParams } }, async (req) => ({
    items: await listUserStories(db, actorOf(req), req.params.id),
  }));

  r.post(
    '/projects/:id/user-stories',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            requirementId: Type.Optional(Type.Union([Uuid, Type.Null()])),
            code: Type.Optional(Type.String({ maxLength: 40 })),
            asA: Type.String({ minLength: 1, maxLength: 300 }),
            iWant: Type.String({ minLength: 1, maxLength: 2000 }),
            soThat: Type.Optional(Type.String({ maxLength: 2000 })),
            priority: Type.Optional(PrioritySchema),
          },
          strict,
        ),
      },
    },
    async (req, reply) =>
      reply.code(201).send(await createUserStory(db, actorOf(req), req.params.id, req.body as never)),
  );

  r.put(
    '/user-stories/:id',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            asA: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
            iWant: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
            soThat: Type.Optional(Type.String({ maxLength: 2000 })),
            priority: Type.Optional(PrioritySchema),
            expectedVersion: ExpectedVersion,
          },
          strict,
        ),
      },
    },
    async (req) => updateUserStory(db, actorOf(req), req.params.id, req.body as never),
  );

  r.post(
    '/user-stories/:id/transitions',
    {
      schema: {
        params: IdParams,
        body: Type.Object({ to: RequirementStatusSchema, expectedVersion: ExpectedVersion }, strict),
      },
    },
    async (req) =>
      transitionUserStory(db, actorOf(req), req.params.id, req.body.to as never, req.body.expectedVersion),
  );

  r.get('/user-stories/:id/acceptance-criteria', { schema: { params: IdParams } }, async (req) => ({
    items: await listAcceptanceCriteria(db, actorOf(req), req.params.id),
  }));

  r.post(
    '/user-stories/:id/acceptance-criteria',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            code: Type.Optional(Type.String({ maxLength: 60 })),
            given: Type.Optional(Type.String({ maxLength: 2000 })),
            when: Type.Optional(Type.String({ maxLength: 2000 })),
            then: Type.String({ minLength: 1, maxLength: 2000 }),
            verificationKind: Type.Optional(VerificationKindSchema),
          },
          strict,
        ),
      },
    },
    async (req, reply) =>
      reply
        .code(201)
        .send(await createAcceptanceCriterion(db, actorOf(req), req.params.id, req.body as never)),
  );

  r.put(
    '/acceptance-criteria/:id',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            given: Type.Optional(Type.String({ maxLength: 2000 })),
            when: Type.Optional(Type.String({ maxLength: 2000 })),
            then: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
            verificationKind: Type.Optional(VerificationKindSchema),
            expectedVersion: ExpectedVersion,
          },
          strict,
        ),
      },
    },
    async (req) => updateAcceptanceCriterion(db, actorOf(req), req.params.id, req.body as never),
  );
}
