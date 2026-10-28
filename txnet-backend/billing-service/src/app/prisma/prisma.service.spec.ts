/**
 * How long a billing transaction waits for a connection (LIVE-1-a, user
 * 2026-10-28). Thirty purchases at once on a pool of 5 waited past Prisma's
 * default 2 s to start their transaction and failed P2028 — 22 of 30 paid
 * nothing and saw a 500. The pool is now 20 (`connection_limit` in the
 * compose URL) and a transaction waits up to 10 s, so a burst queues in
 * PgBouncer instead of failing. What breaks without anyone seeing it: a
 * client built without the option is back on 2 s, and only a burst shows it.
 */
import { vi } from 'vitest';

const built: unknown[] = [];
vi.mock('@prisma/client', async (original) => {
  const real = await original<typeof import('@prisma/client')>();
  class PrismaClient {
    constructor(options: unknown) {
      built.push(options);
    }
  }
  return { ...real, PrismaClient };
});

import { PrismaService } from './prisma.service';

describe('PrismaService — a transaction waits for a free connection', () => {
  it('opens interactive transactions with a 10 s wait, on the URL it was given', () => {
    new PrismaService('postgresql://billing@db-pool:6432/txnet');

    expect(built).toEqual([{ datasourceUrl: 'postgresql://billing@db-pool:6432/txnet', transactionOptions: { maxWait: 10_000 } }]);
  });
});
