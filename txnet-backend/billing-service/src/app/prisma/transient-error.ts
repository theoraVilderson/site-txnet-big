import { Prisma } from '@prisma/client';

/**
 * Prisma codes that say the database was busy or briefly away, not that the
 * work was wrong: no connection in time (P2024), no transaction in time or one
 * that expired (P2028), a write conflict or deadlock (P2034), the server
 * unreachable or the connection closed (P1001, P1002, P1008, P1017).
 */
const TRANSIENT_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);

/** A fault the same work may pass on a later try (LIVE-1-k): queued work leaves its row for the next tick instead of failing it for good. */
export function isTransientDbError(e: unknown): boolean {
  return (e instanceof Prisma.PrismaClientKnownRequestError && TRANSIENT_CODES.has(e.code)) || e instanceof Prisma.PrismaClientInitializationError;
}
