import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  NotificationClientFactory,
  PgNotificationListener,
  workerIsRunnable,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { OutboxRelayJob } from './outbox-relay.job';

/** The channel `20260925000200_the_outbox_wakes_its_relay` notifies on. */
export const OUTBOX_READY_CHANNEL = 'outbox_ready';

export const OUTBOX_READY_LISTEN_CLIENT = Symbol('OUTBOX_READY_LISTEN_CLIENT');

/**
 * F-067-n (ADR-0084 decision 1) — **Postgres wakes the relay**, so an event is
 * published about a second after its transaction commits instead of up to one
 * `AUTOMATION_TICK_INTERVAL_MS` later.
 *
 * An `AFTER INSERT` trigger on `automation.outbox_event` notifies
 * `outbox_ready`; this holds the `LISTEN` and runs `OutboxRelayJob.run()` when
 * woken. The relay is unchanged — the same `SKIP LOCKED` claim, the same
 * stamp-after-confirm (invariant #10) — so a woken pass and a ticked one are
 * the same pass, and two at once only split the batch. **The tick stays**: it
 * is the fallback for a lost notification and the path that records runs.
 *
 * **One pass in flight, one queued.** A burst of inserts is a burst of
 * notifications; a wake during a pass only marks one more pass owed, and that
 * pass reads the table after every insert that woke it had committed.
 *
 * **A pass on every (re)connect** (`recomputeAll`): a notification sent while
 * nobody listened is not queued for anyone.
 *
 * **The worker's switch still stops it** (invariant #1): a woken pass is a
 * run of `outbox_relay`, so `workerIsRunnable` is read before each one.
 */
@Injectable()
export class OutboxRelayListener extends PgNotificationListener {
  protected readonly channel = OUTBOX_READY_CHANNEL;
  protected readonly logger = new Logger(OutboxRelayListener.name);
  private pass: Promise<void> | null = null;
  private owed = false;

  constructor(
    private readonly relay: OutboxRelayJob,
    private readonly prisma: PrismaService,
    @Inject(OUTBOX_READY_LISTEN_CLIENT) newClient: NotificationClientFactory,
  ) {
    super(newClient);
  }

  /** The payload is empty: every notification means the same thing. */
  handle(_payload?: string): Promise<void> {
    return this.wake();
  }

  recomputeAll(): Promise<void> {
    return this.wake();
  }

  private wake(): Promise<void> {
    if (this.pass) {
      this.owed = true;
      return this.pass;
    }
    this.pass = this.drain().finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  private async drain(): Promise<void> {
    do {
      this.owed = false;
      try {
        const worker = await this.prisma.botWorker.findUnique({
          where: { key: this.relay.key },
          select: { isActive: true },
        });
        // No row yet means the registry has not reconciled it; the tick owns that case.
        if (!worker || !workerIsRunnable(worker).due) return;
        await this.relay.run();
      } catch (error) {
        // The row keeps its `lastError` and the tick retries it; a wake only
        // ever makes the relay earlier, never the only chance.
        this.logger.warn(`woken outbox relay pass failed: ${(error as Error).message}`);
      }
    } while (this.owed);
  }
}
