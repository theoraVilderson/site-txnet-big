import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BrokerService,
  type BotUpdateMessage,
} from '../broker/broker.service';

/** The one route this consumer exists to call. Service callers only. */
const DISPATCH_PATH = '/api/internal/bots/dispatch';

/**
 * Runs the bot conversation the webhook enqueued (F-067-b).
 *
 * **Why this is an HTTP call and not a flow.** The conversation is `bot-app`'s
 * — the dispatcher, five flows, the Redis nav store, the chat's session and the
 * `auth-api` client, which is most of `bot-service`. Moving it here means
 * moving it across an Nx application boundary into a workspace library, and
 * this process has now answered that question the same way three times:
 * `VaultRetentionJob` (F-031-c), `OtpDeliveryConsumer` (F-067-a) and this.
 * Reach the owning service over the internal seam; do not move its code.
 *
 * What the feature removes is the flow from the **webhook request** — the one
 * Telegram times out on and redelivers, which is how one slow tenant earned
 * duplicate updates for every tenant sharing the process.
 *
 * **Ordering is not this class's doing.** One chat's updates always land on
 * one queue, and each queue has one consumer at `prefetch: 1`
 * (`BrokerService.consumeBotUpdates`, D-16). What this class must not do is
 * return before the flow is finished — an early ack is the ordering guarantee
 * thrown away one line before it was earned.
 *
 * **Not a `Job`.** No schedule, no `bot_worker` row, nothing to reconcile —
 * giving it one would put a run-log entry against every message any user sends
 * the bot.
 */
@Injectable()
export class BotUpdateConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(BotUpdateConsumer.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly broker: BrokerService,
    config: ConfigService,
  ) {
    this.baseUrl = config
      .get<string>('BOT_API_BASE_URL', '')
      .replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('BOT_API_TIMEOUT_MS', 30_000);
  }

  async onApplicationBootstrap() {
    await this.broker.consumeBotUpdates((message) => this.dispatch(message));
  }

  /**
   * Hand one update back to `bot-service` and wait for the flow to finish.
   *
   * Throwing dead-letters the message (F-067-d), so this throws only for what
   * a redelivery could plausibly survive or an operator has to see — an
   * unreachable service, an unset seam, a 5xx. A 200 saying `dispatched:false`
   * is an update whose bot no longer exists, which redelivery cannot fix and
   * no user is waiting on; it is acked.
   */
  private async dispatch(message: BotUpdateMessage): Promise<void> {
    // Read per message, not at boot, for the reason the OTP consumer states:
    // both variables are optional in this service's schema on purpose, because
    // it holds no credential of its own and must boot without one.
    if (!this.baseUrl) throw new Error('BOT_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${DISPATCH_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RequestHeaders.serviceToken]: this.serviceToken,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 404 is the guard's answer to a caller it does not recognise, which
        // is the shape a rotated-away `SERVICE_AUTH_TOKEN` takes here. 400 is
        // a body `bot-service` published and cannot read back — a bug in the
        // pair, and one worth a dead-letter row rather than a retry loop.
        throw new Error(
          `bot-service answered ${response.status} to ${DISPATCH_PATH}`,
        );
      }

      const body = (await response.json()) as { dispatched?: unknown };
      if (typeof body?.dispatched !== 'boolean') {
        throw new Error(
          `bot-service answered ${DISPATCH_PATH} without a boolean 'dispatched'`,
        );
      }
      if (!body.dispatched) {
        this.logger.warn(
          `dropped an update for chat ${message.chatId ?? 'unknown'} — its bot no longer resolves`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
