import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BrokerService, DeadMessage } from '../broker/broker.service';
import { PrismaService } from '../prisma/prisma.service';
import { deadLetterRecordOf } from './dead-letter';

/**
 * F-067-d — **the one place an operator sees what the queue could not deliver.**
 *
 * A consumer, not a `Job`: it is not scheduled, it has no `bot_worker` row and
 * it never becomes due. A job would have made it a thing that runs every few
 * minutes and finds nothing, and would have put its own failures on the queue
 * it exists to drain.
 *
 * **Why a table and not the queue itself.** A dead-letter queue is a place
 * messages accumulate, not a place anyone looks: reading it means consuming it,
 * and whoever looks last decides what everyone else never sees. A row is
 * durable past a purge, survives the broker being rebuilt, is what F-067-g
 * counts, and is what a re-drive would later read from.
 *
 * **A write failure leaves the message on the queue.** `consumeDeadLetters`
 * nacks with requeue for this handler, because at that moment the queue holds
 * the only copy of the message. A database that is down therefore stops the
 * drain rather than consuming what it cannot record — the failure mode this
 * whole item exists to remove.
 */
@Injectable()
export class DeadLetterDrain implements OnModuleInit {
  private readonly logger = new Logger(DeadLetterDrain.name);

  constructor(
    private readonly broker: BrokerService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    await this.broker.consumeDeadLetters((message) => this.record(message));
  }

  private async record(message: DeadMessage): Promise<void> {
    const record = deadLetterRecordOf(message);

    await this.prisma.deadLetter.create({
      data: {
        routingKey: record.routingKey,
        workerKey: record.workerKey,
        reason: record.reason,
        attempts: record.attempts,
        detail: record.detail,
        // `payload` is Json and Prisma's Json column will not take `null` as a
        // value the way a scalar does; an unparseable body has `rawPayload`
        // instead, and the two are never both set.
        ...(record.payload ? { payload: record.payload as object } : {}),
        rawPayload: record.rawPayload,
      },
    });

    this.logger.warn(
      `recorded a dead-lettered message: ${record.routingKey} ` +
        `(${record.reason}, attempt ${record.attempts})`,
    );
  }
}
