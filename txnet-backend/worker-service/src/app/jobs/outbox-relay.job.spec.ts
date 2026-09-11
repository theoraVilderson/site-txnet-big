import { ConfigService } from '@nestjs/config';
import { PublishNotConfirmedError } from '@txnet-backend/shared-core';
import { OutboxRelayJob } from './outbox-relay.job';
import { BrokerService } from '../broker/broker.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What this relay must never do is **stamp a row published that was not**.
 *
 * ADR-0021's whole argument is that the event and the state change that caused
 * it commit together, so that there is no window in which money moved and the
 * event vanished. A relay that marks `publishedAt` on a row the broker never
 * confirmed re-opens exactly that window one step later, and re-opens it
 * silently: the table then says the system announced something it did not, and
 * nothing anywhere disagrees.
 *
 * So the invariant stated here is: **`publishedAt` is written only after a
 * confirmed, routable publish of that row** (automation invariant #10), and a
 * publish that fails leaves the row claimable with its reason recorded.
 *
 * The second thing stated is the bookkeeping order, which is easy to get wrong
 * and impossible to see afterwards: the `lastError` write happens **outside**
 * the transaction the failure rolled back. Written inside it, the only record
 * of why the relay is stuck would be rolled back along with the failure.
 */
describe('OutboxRelayJob', () => {
  type Row = {
    id: string;
    aggregate: string;
    aggregateId: string;
    type: string;
    payload: unknown;
    occurredAt: Date;
  };

  const row = (id: string, type = 'payment.confirmed'): Row => ({
    id,
    aggregate: 'billing.payment',
    aggregateId: `agg-${id}`,
    type,
    payload: { amount: '1000' },
    occurredAt: new Date('2026-09-10T10:00:00Z'),
  });

  /**
   * A Prisma double that behaves like the real client in the one way this job
   * depends on: `$transaction` hands a client to a callback, and anything the
   * callback did is discarded when it throws.
   */
  const prismaWith = (rows: Row[]) => {
    const claimed: unknown[] = [];
    const inTx = { updates: [] as unknown[] };
    const committed: unknown[] = [];
    const outsideTx: unknown[] = [];

    const tx = {
      $queryRaw: jest.fn(async () => {
        claimed.push(rows);
        return rows;
      }),
      outboxEvent: {
        update: jest.fn(async (args: unknown) => {
          inTx.updates.push(args);
          return args;
        }),
      },
    };

    const prisma = {
      $transaction: jest.fn(async (fn: (c: typeof tx) => Promise<void>) => {
        inTx.updates = [];
        try {
          await fn(tx);
        } catch (err) {
          inTx.updates = []; // rolled back
          throw err;
        }
        committed.push(...inTx.updates);
      }),
      outboxEvent: {
        update: jest.fn(async (args: unknown) => {
          outsideTx.push(args);
          return args;
        }),
      },
    };

    return { prisma, tx, committed, outsideTx };
  };

  const config = (batch = 100) =>
    ({
      get: <T>(key: string, fallback?: T) =>
        (key === 'AUTOMATION_OUTBOX_BATCH' ? (batch as unknown as T) : undefined) ??
        (fallback as T),
    }) as unknown as ConfigService;

  const jobWith = (
    prisma: unknown,
    publish: jest.Mock,
    batch?: number,
  ): OutboxRelayJob =>
    new OutboxRelayJob(
      prisma as PrismaService,
      { publishOutboxEvent: publish } as unknown as BrokerService,
      config(batch),
    );

  it('publishes every claimed row and stamps each one inside the transaction', async () => {
    const { prisma, committed } = prismaWith([row('a'), row('b')]);
    const publish = jest.fn().mockResolvedValue(undefined);

    const result = await jobWith(prisma, publish).run();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      itemsProcessed: 2,
      errorsCount: 0,
      metrics: { published: 2 },
    });
    expect(committed).toHaveLength(2);
    expect(committed[0]).toMatchObject({ where: { id: 'a' } });
  });

  it('sends the row to outbox.<type>, as the wire shape, with the row id as the event id', async () => {
    const { prisma } = prismaWith([row('a')]);
    const publish = jest.fn().mockResolvedValue(undefined);

    await jobWith(prisma, publish).run();

    expect(publish).toHaveBeenCalledWith('outbox.payment.confirmed', {
      id: 'a',
      aggregate: 'billing.payment',
      aggregateId: 'agg-a',
      type: 'payment.confirmed',
      occurredAt: '2026-09-10T10:00:00.000Z',
      payload: { amount: '1000' },
    });
  });

  it('does not stamp a row the broker would not take, and stops the batch there', async () => {
    const { prisma, committed } = prismaWith([row('a'), row('b'), row('c')]);
    const publish = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new PublishNotConfirmedError('unroutable', 'reached no queue'),
      );

    await expect(jobWith(prisma, publish).run()).rejects.toThrow(/outbox/i);

    // 'a' went, 'b' failed, 'c' was never attempted — the broker is the
    // problem, and burning the rest of the batch against it buys nothing.
    expect(publish).toHaveBeenCalledTimes(2);
    // Nothing committed: the throw rolled the transaction back, so even 'a'
    // stays unpublished and is republished next tick. At-least-once is the
    // guarantee ADR-0021 bought; losing 'a' is not.
    expect(committed).toHaveLength(0);
  });

  it('records why on the failed row, outside the transaction that rolled back', async () => {
    const { prisma, outsideTx } = prismaWith([row('a')]);
    const publish = jest
      .fn()
      .mockRejectedValue(
        new PublishNotConfirmedError('unroutable', 'reached no queue'),
      );

    await expect(jobWith(prisma, publish).run()).rejects.toThrow();

    expect(outsideTx).toHaveLength(1);
    expect(outsideTx[0]).toMatchObject({
      where: { id: 'a' },
      data: {
        attempts: { increment: 1 },
        lastError: expect.stringContaining('unroutable'),
      },
    });
  });

  it('a run that found nothing to publish is a success, not a failure', async () => {
    const { prisma } = prismaWith([]);
    const publish = jest.fn();

    const result = await jobWith(prisma, publish).run();

    expect(publish).not.toHaveBeenCalled();
    expect(result).toEqual({
      itemsProcessed: 0,
      errorsCount: 0,
      metrics: { published: 0 },
    });
  });

  it('refuses an event type that is not a routing-key path, without publishing it', async () => {
    const { prisma, outsideTx } = prismaWith([row('a', 'payment confirmed')]);
    const publish = jest.fn().mockResolvedValue(undefined);

    await expect(jobWith(prisma, publish).run()).rejects.toThrow();

    // The broker was never asked: a type with a space in it matches no binding
    // and the row would sit unpublished with nothing saying why.
    expect(publish).not.toHaveBeenCalled();
    expect(outsideTx[0]).toMatchObject({
      data: { lastError: expect.stringContaining('routing-key path') },
    });
  });
});
