import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  bootstrapOwner,
  createUser,
  getWorkspace,
  isBootstrapped,
  listAuditLogs,
  listWorkspaceMembers,
  login,
  logout,
  removeWorkspaceMember,
  SESSION_TTL_MS,
  setWorkspaceMemberRole,
  updateWorkspace,
} from '@platform/iam';
import { actorOf, SESSION_COOKIE } from '../auth-plugin.js';
import type { AppDeps } from '../deps.js';
import { ExpectedVersion, IdParams, PaginationQuery, RoleSchema, strict, Uuid } from '../schemas.js';

export function iamRoutes(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const { db } = deps;
  const cookieOpts = { httpOnly: true, sameSite: 'strict' as const, secure: deps.cookieSecure, path: '/' };

  r.get('/auth/status', { config: { public: true } }, async (req) => ({
    bootstrapped: await isBootstrapped(db),
    authenticated: !!req.auth,
  }));

  r.post(
    '/auth/bootstrap',
    {
      config: { public: true, rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object(
          {
            email: Type.String({ maxLength: 254 }),
            password: Type.String({ maxLength: 256 }),
            displayName: Type.String({ minLength: 1, maxLength: 120 }),
            workspaceName: Type.Optional(Type.String({ maxLength: 120 })),
          },
          strict,
        ),
      },
    },
    async (req, reply) => {
      const result = await bootstrapOwner(db, req.body);
      return reply.code(201).send(result);
    },
  );

  r.post(
    '/auth/login',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object(
          { email: Type.String({ maxLength: 254 }), password: Type.String({ maxLength: 256 }) },
          strict,
        ),
      },
    },
    async (req, reply) => {
      const { token, context, expiresAt } = await login(db, req.body);
      reply.setCookie(SESSION_COOKIE, token, {
        ...cookieOpts,
        expires: expiresAt,
        maxAge: SESSION_TTL_MS / 1000,
      });
      return {
        user: context.user,
        workspaceId: context.workspaceId,
        role: context.role,
        expiresAt: expiresAt.toISOString(),
      };
    },
  );

  r.post('/auth/logout', { config: { public: true } }, async (req, reply) => {
    if (req.sessionToken) await logout(db, req.sessionToken);
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return reply.code(204).send();
  });

  r.get('/auth/me', async (req) => ({
    user: req.auth!.user,
    workspaceId: req.auth!.workspaceId,
    role: req.auth!.role,
  }));

  // ------------------------------------------------------------ users / workspace members
  r.get('/users', async (req) => ({ items: await listWorkspaceMembers(db, actorOf(req)) }));

  r.post(
    '/users',
    {
      schema: {
        body: Type.Object(
          {
            email: Type.String({ maxLength: 254 }),
            displayName: Type.String({ minLength: 1, maxLength: 120 }),
            password: Type.String({ maxLength: 256 }),
            role: RoleSchema,
          },
          strict,
        ),
      },
    },
    async (req, reply) => reply.code(201).send(await createUser(db, actorOf(req), req.body as never)),
  );

  r.put(
    '/users/:id/role',
    { schema: { params: IdParams, body: Type.Object({ role: RoleSchema }, strict) } },
    async (req, reply) => {
      await setWorkspaceMemberRole(db, actorOf(req), req.params.id, req.body.role as never);
      return reply.code(204).send();
    },
  );

  r.delete('/users/:id', { schema: { params: IdParams } }, async (req, reply) => {
    await removeWorkspaceMember(db, actorOf(req), req.params.id);
    return reply.code(204).send();
  });

  r.get('/workspaces/current', async (req) => getWorkspace(db, actorOf(req)));

  r.put(
    '/workspaces/current',
    {
      schema: {
        body: Type.Object(
          { name: Type.String({ minLength: 1, maxLength: 120 }), expectedVersion: ExpectedVersion },
          strict,
        ),
      },
    },
    async (req) => updateWorkspace(db, actorOf(req), req.body),
  );

  // ------------------------------------------------------------ audit
  r.get(
    '/audit-logs',
    {
      schema: {
        querystring: Type.Intersect([
          PaginationQuery,
          Type.Object({
            projectId: Type.Optional(Uuid),
            targetType: Type.Optional(Type.String()),
            targetId: Type.Optional(Type.String()),
          }),
        ]),
      },
    },
    async (req) => listAuditLogs(db, actorOf(req), req.query),
  );
}
