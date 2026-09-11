import { IdentityHeaders, RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BrokerService,
  type OtpDeliveryMessage,
} from '../broker/broker.service';

/** The one route this consumer exists to call. Service callers only. */
const DELIVER_PATH = '/api/internal/otp/deliver';

/**
 * Sends the OTP that `auth-service` answered a 202 for (F-067-a).
 *
 * **Why this is an HTTP call and not a send.** The senders are identity's,
 * they are tenant-scoped, and they need `BotLinkStore`, `TenantContext`,
 * `LocaleService` and the messenger client registry. Moving them here means
 * moving all of that across an Nx application boundary into a workspace
 * library to serve one caller — the question `VaultRetentionJob` already asked
 * and already answered the other way (F-031-c). Two answers to one question in
 * one worker would be the expensive thing, not the extra hop.
 *
 * What the user's login request loses is the provider round trip, and the
 * Redis lock it was holding for the length of it. That was the failure the row
 * was opened for.
 *
 * `X-Tenant-Id` is what scopes the send. The header is forgeable and the
 * service token is not, which is why `auth-api` honours it only from a
 * verified service caller (`TenantMiddleware.botClaim`); the value is the
 * tenant the *request* resolved to, carried on the message because this
 * process has no ambient scope of its own.
 *
 * **Not a `Job`.** A job is a tick's unit of work and writes a
 * `bot_execution_log` row; this is a queue consumer with no schedule, no
 * `bot_worker` row and nothing to reconcile. Giving it one would put a run log
 * entry against every OTP in the system.
 */
@Injectable()
export class OtpDeliveryConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(OtpDeliveryConsumer.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly broker: BrokerService,
    config: ConfigService,
  ) {
    this.baseUrl = config
      .get<string>('AUTH_API_BASE_URL', '')
      .replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 30_000);
  }

  async onApplicationBootstrap() {
    await this.broker.consumeOtpDeliveries((message) => this.deliver(message));
    this.logger.log('consuming OTP delivery requests');
  }

  /**
   * Ask `auth-api` to draw and send the code.
   *
   * Throwing dead-letters the message (F-067-d), so this throws only for
   * failures a redelivery could plausibly survive or an operator has to see —
   * an unreachable API, an unset seam, a 5xx. A 200 saying `delivered:false` is
   * a refusal the sending side has already recorded against the delivery id,
   * and it is acked.
   */
  private async deliver(message: OtpDeliveryMessage): Promise<void> {
    // Read per message, not at boot. Both variables are optional in this
    // service's schema on purpose: `worker-service` holds no credential of its
    // own and must boot without one.
    if (!this.baseUrl) throw new Error('AUTH_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${DELIVER_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RequestHeaders.serviceToken]: this.serviceToken,
          [IdentityHeaders.tenantId]: message.tenantId,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 404 is the guard's answer to a caller it does not recognise, which is
        // the shape a rotated-away `SERVICE_AUTH_TOKEN` takes here.
        throw new Error(
          `auth-api answered ${response.status} to ${DELIVER_PATH}`,
        );
      }

      const body = (await response.json()) as { delivered?: unknown };
      if (typeof body?.delivered !== 'boolean') {
        throw new Error(
          `auth-api answered ${DELIVER_PATH} without a boolean 'delivered'`,
        );
      }
      if (!body.delivered) {
        this.logger.warn(
          `delivery ${message.deliveryId} was refused by ${message.channel} — recorded, not retried`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
