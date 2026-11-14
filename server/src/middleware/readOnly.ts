import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Read-Only guardrail.
 *
 * Fail-closed: a mutating request is allowed ONLY when
 *   - FORCE_READ_ONLY is not "true" on the container, AND
 *   - the client explicitly sends `X-Read-Only: false`.
 * A missing or malformed header is treated as read-only, so a buggy client or a
 * stray curl can never write through a jump host by accident.
 */

export function isForceReadOnly(): boolean {
  return (process.env.FORCE_READ_ONLY ?? '').trim().toLowerCase() === 'true';
}

export function isRequestReadOnly(request: FastifyRequest): boolean {
  if (isForceReadOnly()) return true;
  const header = request.headers['x-read-only'];
  const value = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
  return value !== 'false';
}

/** Fastify preHandler for every mutating route. */
export async function requireWritable(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isRequestReadOnly(request)) return;
  const reason = isForceReadOnly()
    ? 'FORCE_READ_ONLY is enabled on this LiteMongo instance'
    : 'connection is in Read-Only mode (send X-Read-Only: false to allow writes)';
  await reply.code(403).send({ error: 'READ_ONLY', message: `Write blocked: ${reason}.` });
}
