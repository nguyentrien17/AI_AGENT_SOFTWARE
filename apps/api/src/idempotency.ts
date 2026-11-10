import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, lt } from 'drizzle-orm';
import { type Db, idempotencyKeys, isUniqueViolation } from '@platform/db';
import {
  canonicalJson,
  ConflictError,
  sha256Hex,
  UnprocessableError,
  ValidationError,
} from '@platform/shared';

const HEADER = 'idempotency-key';
const TTL_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

declare module 'fastify' {
  interface FastifyRequest {
    idempotency: { key: string; rowId: string } | null;
  }
}

/**
 * Idempotency-Key support for state-mutating requests (Blueprint §14). The first request with a key is
 * executed and its response stored; replays with the same key and payload return the stored response;
 * reuse with a different payload is rejected with 422.
 */
export function registerIdempotency(app: FastifyInstance, db: Db) {
  app.decorateRequest('idempotency', null);

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
    const raw = req.headers[HEADER];
    if (raw === undefined || !req.auth) return;
    const key = Array.isArray(raw) ? raw[0]! : raw;
    if (!KEY_RE.test(key)) throw new ValidationError('Idempotency-Key must be 8-128 chars [A-Za-z0-9_-:.]');
    const userId = req.auth.user.id;
    const requestHash = sha256Hex(`${req.method} ${req.url}\n${canonicalJson(req.body ?? null)}`);

    await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, new Date()));
    const [existing] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId)))
      .limit(1);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new UnprocessableError(
          'Idempotency-Key was already used with a different request',
          'idempotency_key_reused',
        );
      }
      if (existing.responseStatus == null)
        throw new ConflictError(
          'A request with this Idempotency-Key is in progress',
          'idempotency_in_progress',
        );
      reply.header('idempotent-replayed', 'true');
      return reply.code(existing.responseStatus).send(existing.responseBody);
    }
    try {
      const [row] = await db
        .insert(idempotencyKeys)
        .values({
          key,
          userId,
          method: req.method,
          path: req.url,
          requestHash,
          expiresAt: new Date(Date.now() + TTL_MS),
        })
        .returning({ id: idempotencyKeys.id });
      req.idempotency = { key, rowId: row!.id };
    } catch (e) {
      if (isUniqueViolation(e))
        throw new ConflictError(
          'A request with this Idempotency-Key is in progress',
          'idempotency_in_progress',
        );
      throw e;
    }
  });

  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const ctx = req.idempotency;
    if (!ctx) return payload;
    req.idempotency = null;
    if (reply.statusCode >= 500) {
      // Server failures are not cached so the client can retry with the same key.
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, ctx.rowId));
      return payload;
    }
    let body: unknown = null;
    if (typeof payload === 'string' && payload.length) {
      try {
        body = JSON.parse(payload);
      } catch {
        body = payload;
      }
    }
    await db
      .update(idempotencyKeys)
      .set({ responseStatus: reply.statusCode, responseBody: body })
      .where(eq(idempotencyKeys.id, ctx.rowId));
    return payload;
  });
}
