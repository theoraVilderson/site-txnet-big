import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory, Prisma } from '@prisma/client';
import {
  outboxRoutingKey,
  PublishNotConfirmedError,
  type OutboxMessage,
} from '@txnet-backend/shared-core';
import { Job, JobResult } from '../automation/job';
import { BrokerService } from '../broker/broker.service';
import { PrismaService } from '../prisma/prisma.service';

/** The columns a publish needs. `attempts` and `lastError` are written, not read. */
interface OutboxRow {
  id: string;
  aggregate: string;
  aggregateId: string;
  type: string;
  payload: Prisma.JsonValue;
  occurredAt: Date;
}

/**
 * F-067-c — **the half of ADR-0021 that was decided and never built.**
 *
 * The ADR made a cross-domain event and the state change that caused it commit
 * together: the producing service inserts an `automation.outbox_event` row
 * inside the same Postgres transaction that writes the ledger, and this job
 * drains the unpublished ones onto the broker. Until now there was no table
 * and no relay, and nothing broke only because every producing domain
 * (`billing`, `network`, `notification`, `ai`) is still `draft`.
 *
 * **A third `Job`, not a new unit and not a new deployable** (D-14). It ticks
 * beside `worker_heartbeat` and `vault_credential_retention`, which means it
 * needs an `always_on` `bot_schedule` like they do, and its latency is one
 * `AUTOMATION_TICK_INTERVAL_MS`. That is the cost of not owning a second
 * process for a table that has no writer yet, and it is a schedule change on
 * the day a payment cannot wait a minute.
 *
 * **Rows are claimed `FOR UPDATE SKIP LOCKED`.** ADR-0027 makes redelivery
 * ordinary and a `bot_worker` may be consumed by several replicas, so two
 * relays running at once is the expected case, not the pathological one.
 * `SKIP LOCKED` is what makes that harmless: each transaction takes a disjoint
 * batch and neither waits on the other. Without it the second relay blocks on
 * the first's rows and publishes them all again the moment it unblocks.
 *
 * **`publishedAt` is stamped inside the same transaction as the publish, after
 * a confirmed one.** The two failure directions are not symmetric and that is
 * deliberate: a publish that succeeded and a stamp that rolled back means the
 * event is sent twice, which ADR-0021 buys explicitly (at-least-once, keyed on
 * the event id). A stamp that committed against a publish that never happened
 * means the event is lost with the table asserting it was sent — the exact
 * window the outbox exists to close. So the order only ever risks the first.
 *
 * **Safe to run twice** (the `Job` contract), for the same reason: the worst a
 * duplicate run does is republish an event a consumer must already be
 * idempotent about.
 *
 * **It never succeeds quietly.** A batch that could not be published throws,
 * so `TickConsumer` writes a `failed` run (invariant #3) rather than a
 * `success` with a count of zero — which is indistinguishable from an empty
 * outbox, and an empty outbox is what a healthy one looks like.
 */
@Injectable()
export class OutboxRelayJob implements Job {
  readonly key = 'outbox_relay';
  readonly name = 'Outbox relay';
  readonly description =
    'Publishes unpublished automation.outbox_event rows to the broker (ADR-0021).';
  readonly category = BotWorkerCategory.other;

  private readonly logger = new Logger(OutboxRelayJob.name);
  private readonly batchSize: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly broker: BrokerService,
    config: ConfigService,
  ) {
    this.batchSize = config.get<number>('AUTOMATION_OUTBOX_BATCH', 100);
  }

  async run(): Promise<JobResult> {
    let published = 0;
    // Filled inside the transaction and written **after** it has rolled back.
    // A `lastError` written inside is rolled back with the failure it
    // describes, which leaves a stuck relay with nothing anywhere saying why.
    // An array rather than a nullable because it is assigned in a callback and
    // read after it, which is where TypeScript's narrowing cannot follow.
    const failed: { id: string; message: string }[] = [];

    try {
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT "id", "aggregate", "aggregateId", "type", "payload", "occurredAt"
          FROM "automation"."outbox_event"
          WHERE "publishedAt" IS NULL
          ORDER BY "occurredAt" ASC
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED
        `;

        for (const row of rows) {
          try {
            // The routing key is derived here rather than in the broker because
            // this is where an untrusted column becomes an address: `type` is
            // written by a producing domain, and AMQP does not refuse a bad
            // routing key — it silently matches nothing.
            await this.broker.publishOutboxEvent(
              outboxRoutingKey(row.type),
              messageOf(row),
            );
          } catch (err) {
            failed.push({ id: row.id, message: reasonOf(err) });
            // Stop the batch rather than working through it. Whatever refused
            // this row — an unreachable broker, an event type nothing is bound
            // to — is about the broker, not about the row, and the remaining
            // rows keep their place in `occurredAt` order for the next tick.
            break;
          }

          await tx.outboxEvent.update({
            where: { id: row.id },
            data: {
              publishedAt: new Date(),
              attempts: { increment: 1 },
              lastError: null,
            },
          });
          published++;
        }

        if (failed.length > 0) throw new Error(failed[0].message);
      });
    } catch (err) {
      // Anything that is not a publish failure — the claim query, the stamp,
      // a connection lost mid-batch — is this job's failure and nothing else's.
      if (failed.length === 0) throw err;
      published = 0; // the transaction rolled back, so nothing was stamped
    }

    if (failed.length > 0) {
      const [failure] = failed;
      await this.prisma.outboxEvent.update({
        where: { id: failure.id },
        data: { attempts: { increment: 1 }, lastError: failure.message },
      });
      throw new Error(
        `outbox relay stopped at event ${failure.id}: ${failure.message}`,
      );
    }

    if (published > 0) this.logger.log(`published ${published} outbox event(s)`);
    return { itemsProcessed: published, errorsCount: 0, metrics: { published } };
  }
}

/**
 * What goes in `lastError`.
 *
 * `PublishNotConfirmedError.reason` is prepended because it is the half an
 * operator acts on and the message alone does not carry it: `nacked` is a
 * broker refusing the message, `timeout` is a broker that stopped answering,
 * and `unroutable` is neither — it is an event type nothing has bound a queue
 * to, which today is every event type, because no consumer exists yet.
 */
function reasonOf(err: unknown): string {
  if (err instanceof PublishNotConfirmedError) {
    return `${err.reason}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** A row as it goes on the wire. `occurredAt` is ISO — a Date does not travel. */
function messageOf(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    aggregate: row.aggregate,
    aggregateId: row.aggregateId,
    type: row.type,
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload,
  };
}
