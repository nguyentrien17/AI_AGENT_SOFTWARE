import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { createLogger } from '@platform/observability';
import { AppError, isAppError, type ProblemDetails, uuidv7 } from '@platform/shared';
import type { AppDeps } from './deps.js';
import { registerAuth } from './auth-plugin.js';
import { registerIdempotency } from './idempotency.js';
import { iamRoutes } from './routes/iam.js';
import { projectRoutes } from './routes/projects.js';
import { workRoutes } from './routes/work.js';

export type { AppDeps };

export const API_PREFIX = '/api/v1';

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const logger = deps.logger ?? createLogger({ level: 'info' });
  const app = Fastify({
    logger: false,
    genReqId: () => uuidv7(),
    bodyLimit: 6 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', allErrors: true } },
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    let problem: ProblemDetails;
    if (isAppError(err)) {
      problem = err.toProblem(req.url);
    } else if ((err as FastifyError).validation) {
      const fe = err as FastifyError;
      problem = {
        type: 'https://errors.ai-agent-platform.local/validation_error',
        title: 'Validation failed',
        status: 400,
        detail: fe.message,
        code: 'validation_error',
        instance: req.url,
        errors: (fe.validation ?? []).map((v) => ({
          path: v.instancePath || String(v.params?.missingProperty ?? ''),
          message: v.message ?? 'invalid',
        })),
      };
    } else if ((err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500) {
      const fe = err as FastifyError;
      const code = (fe.code ?? 'bad_request').toLowerCase();
      problem = {
        type: `https://errors.ai-agent-platform.local/${code}`,
        title: fe.name,
        status: fe.statusCode!,
        detail: fe.message,
        code,
        instance: req.url,
      };
    } else {
      logger.error('unhandled error', { reqId: req.id, method: req.method, url: req.url, err });
      problem = {
        type: 'https://errors.ai-agent-platform.local/internal_error',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred',
        code: 'internal_error',
        instance: req.url,
      };
    }
    if (problem.status >= 500 && isAppError(err)) logger.error('server error', { reqId: req.id, err });
    return reply
      .code(problem.status)
      .type('application/problem+json')
      .send({ ...problem, requestId: req.id });
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .code(404)
      .type('application/problem+json')
      .send({
        type: 'https://errors.ai-agent-platform.local/route_not_found',
        title: 'Not found',
        status: 404,
        code: 'route_not_found',
        detail: `No route ${req.method} ${req.url}`,
        instance: req.url,
      }),
  );

  app.addHook('onResponse', async (req, reply) => {
    logger.info('request', {
      reqId: req.id,
      method: req.method,
      url: req.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      userId: req.auth?.user.id,
    });
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    max: deps.rateLimitPerMinute ?? 600,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) =>
      new AppError({
        status: 429,
        code: 'rate_limited',
        title: 'Too many requests',
        detail: `Rate limit exceeded, retry in ${ctx.after}`,
      }),
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'AI Agent Software Platform API', version: '0.1.0' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'sid' } } },
      security: [{ session: [] }],
    },
  });

  await app.register(
    async (api) => {
      registerAuth(api, deps.db);
      registerIdempotency(api, deps.db);
      api.get('/health', { config: { public: true } }, async () => ({ status: 'ok' }));
      api.get('/openapi.json', { config: { public: true }, schema: { hide: true } }, async () =>
        app.swagger(),
      );
      iamRoutes(api, deps);
      projectRoutes(api, deps);
      workRoutes(api, deps);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
