import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '@platform/shared';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class CsrfOriginError extends AppError {
  constructor(origin: string) {
    super({
      status: 403,
      code: 'csrf_origin_rejected',
      title: 'Cross-origin request rejected',
      detail: `Requests from origin '${origin}' may not change data. Add it to ALLOWED_ORIGINS if it is trusted.`,
    });
  }
}

function requestOrigin(req: FastifyRequest): string | null {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin && origin !== 'null') return origin;
  if (origin === 'null') return 'null'; // sandboxed iframes, file:// pages: never trusted
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return 'null';
    }
  }
  return null;
}

/** Decides whether a state-changing request's origin is trusted. Pure, exported for tests. */
export function isTrustedOrigin(origin: string, host: string | undefined, allowed: readonly string[]): boolean {
  if (origin === 'null') return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (allowed.includes(url.origin)) return true;
  if (host && url.host === host) return true; // same origin as the API itself
  return LOOPBACK_HOSTS.has(url.hostname) && host !== undefined && LOOPBACK_HOSTS.has(host.replace(/:\d+$/, ''));
}

/**
 * CSRF defence in depth on top of SameSite=Strict session cookies (Phase 1 risk R5): a browser always
 * sends `Origin` on cross-site writes, so a write whose origin is neither the API itself, a loopback page
 * talking to a loopback API, nor an explicitly allowed origin is rejected. Clients that send no origin at
 * all (curl, scripts) are not browsers and cannot carry a victim's cookie by accident.
 */
export function registerOriginCheck(app: FastifyInstance, allowedOrigins: readonly string[]) {
  const allowed = allowedOrigins.map((o) => new URL(o).origin);
  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = requestOrigin(req);
    if (origin === null) return;
    if (!isTrustedOrigin(origin, req.headers.host, allowed)) throw new CsrfOriginError(origin);
  });
}
