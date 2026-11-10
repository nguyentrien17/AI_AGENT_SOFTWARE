import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, type AuthContext } from '@platform/iam';
import type { Db } from '@platform/db';
import { type Actor, UnauthenticatedError } from '@platform/shared';

export const SESSION_COOKIE = 'sid';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    sessionToken: string | null;
  }
  interface FastifyContextConfig {
    /** Route is reachable without a session. Everything else is deny-by-default. */
    public?: boolean;
  }
}

export function registerAuth(app: FastifyInstance, db: Db) {
  app.decorateRequest('auth', null);
  app.decorateRequest('sessionToken', null);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    req.sessionToken = token;
    try {
      req.auth = await authenticate(db, token);
    } catch {
      req.auth = null;
    }
  });

  app.addHook('preHandler', async (req: FastifyRequest, _reply: FastifyReply) => {
    if (req.routeOptions.config?.public) return;
    if (!req.auth) throw new UnauthenticatedError();
  });
}

export function actorOf(req: FastifyRequest): Actor {
  if (!req.auth) throw new UnauthenticatedError();
  return { type: 'user', userId: req.auth.user.id, workspaceId: req.auth.workspaceId };
}
