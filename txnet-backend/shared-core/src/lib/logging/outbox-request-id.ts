import { currentRequestId } from './request-scope';

type OutboxEventData = Record<string, unknown>;
type OutboxWrite = { args: { data: OutboxEventData | OutboxEventData[] }; query: (args: unknown) => Promise<unknown> };

function stamp(data: OutboxEventData, requestId: string): OutboxEventData {
  // A writer that named an id (a consumer re-emitting under its message's) keeps it.
  return data['requestId'] === undefined ? { ...data, requestId } : data;
}

function stamped({ args, query }: OutboxWrite): Promise<unknown> {
  const requestId = currentRequestId();
  if (!requestId) return query(args);
  const data = Array.isArray(args.data) ? args.data.map((row) => stamp(row, requestId)) : stamp(args.data, requestId);
  return query({ ...args, data });
}

/**
 * Prisma query hooks that stamp the request in scope on every outbox event
 * written (H13), so the relay can publish it as `x-request-id`. Merged into
 * `withTenant`, the extension every service's injected client already has,
 * so no writer opts in; a client built without it (a `CrossTenantPrismaService`)
 * writes no id.
 */
export const outboxRequestIdQueryMap = {
  outboxEvent: { create: stamped, createMany: stamped },
};
