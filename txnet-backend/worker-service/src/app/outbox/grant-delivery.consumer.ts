import { OutboxEventType, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BrokerService } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';
import { EventNoticeSender } from './event-notice';

/** This consumer's segment of its per-channel markers (ADR-0045, F-067-o). */
const CONSUMER = 'grant-delivery-notify';
/** The tenant owner's notice of a delayed purchase has its own markers (F-601-i): the buyer's landing never stands for it. */
const ALERT_CONSUMER = 'grant-delivery-alert';

/** Why billing says a purchase is still waiting (`DeliveryDelay`, entitlement `delivery.ts`) -> the owner's template. */
const DELAY_TEMPLATE: Record<string, string> = {
  panel_unavailable: 'purchaseStuckPanelUnavailable',
  write_unconfirmed: 'purchaseStuckWriteUnconfirmed',
  strategy_not_built: 'purchaseStuckStrategyNotBuilt',
};

/**
 * Tell a buyer how their purchase ended (F-111-d, spec §5.8 step 3):
 * `entitlement.grant.delivered` — it is ready — or `entitlement.grant.refunded`
 * — it could not be delivered, and `amount` went back to the wallet.
 *
 * Told through `EventNoticeSender` (ADR-0084): the live event on the buyer's
 * own `user:` channel, under the event's own name, so an open My services page
 * turns the Grant live and the top bar re-reads the balance after a refund;
 * then their inbox and bot, each once. Every purchase ends in one of the two,
 * so every buyer hears once.
 *
 * `entitlement.grant.delivery_delayed` (F-601-i) tells two people: the buyer
 * that it is being prepared, and the tenant's owner (`ownerUserId`) why, by
 * `reason`. Each is sent even when the other throws; the event then throws and
 * dead-letters, and a replay repeats only the channel still owed. No live push:
 * no page re-reads on it.
 */
@Injectable()
export class GrantDeliveryConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(GrantDeliveryConsumer.name);
  private readonly notices: EventNoticeSender;

  constructor(
    private readonly broker: BrokerService,
    redis: RedisService,
    realtime: RealtimePublisher,
    config: ConfigService,
  ) {
    this.notices = new EventNoticeSender(redis, realtime, config, broker);
  }

  async onApplicationBootstrap() {
    await this.broker.consumeGrantDeliveryNotices((event) => this.handle(event));
    this.logger.log('consuming entitlement.grant.delivered / .refunded / .delivery_delayed for the buyer notice');
  }

  async handle(event: OutboxMessage): Promise<void> {
    if (event.type === OutboxEventType.GRANT_DELIVERY_DELAYED) return this.delayed(event);
    const grant = grantOf(event);
    const refunded = event.type === OutboxEventType.GRANT_REFUNDED;
    await this.notices.send({
      consumer: CONSUMER,
      eventId: event.id,
      live: {
        channel: `user:${grant.userId}`,
        body: refunded
          ? { type: OutboxEventType.GRANT_REFUNDED, grantId: grant.grantId, invoiceId: grant.invoiceId, amount: grant.amount }
          : { type: OutboxEventType.GRANT_DELIVERED, grantId: grant.grantId },
      },
      person: {
        tenantId: grant.tenantId,
        userId: grant.userId,
        template: refunded ? 'purchaseRefunded' : 'purchaseDelivered',
        params: refunded ? { amount: grant.amount ?? '' } : grant.servicesUrl ? { servicesUrl: grant.servicesUrl } : {},
      },
    });
  }

  private async delayed(event: OutboxMessage): Promise<void> {
    const grant = grantOf(event);
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const ownerUserId = typeof p['ownerUserId'] === 'string' && p['ownerUserId'] !== '' ? p['ownerUserId'] : null;
    const template = typeof p['reason'] === 'string' ? DELAY_TEMPLATE[p['reason']] : undefined;
    if (!ownerUserId || !template) throw new Error(`outbox event ${event.id} is a delayed purchase without its owner or a known reason`);

    const sent = await Promise.allSettled([
      this.notices.send({
        consumer: CONSUMER,
        eventId: event.id,
        person: { tenantId: grant.tenantId, userId: grant.userId, template: 'purchaseDelayed', params: {} },
      }),
      this.notices.send({
        consumer: ALERT_CONSUMER,
        eventId: event.id,
        person: {
          tenantId: grant.tenantId,
          userId: ownerUserId,
          template,
          params: template === DELAY_TEMPLATE.panel_unavailable ? { panels: String(p['waitingPanels'] ?? '') } : {},
        },
      }),
    ]);
    const failed = sent.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

type GrantEvent = {
  tenantId: string;
  userId: string;
  grantId: string;
  invoiceId: string | null;
  amount: string | null;
  servicesUrl: string | null;
};

/** The payload, or a throw: an event that does not say whose Grant it is is not one to guess about. */
function grantOf(event: OutboxMessage): GrantEvent {
  if (event.type !== OutboxEventType.GRANT_DELIVERED && event.type !== OutboxEventType.GRANT_REFUNDED && event.type !== OutboxEventType.GRANT_DELIVERY_DELAYED) {
    throw new Error(`outbox event ${event.id} is ${event.type}, not a Grant delivery`);
  }
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
  const tenantId = str('tenantId');
  const userId = str('userId');
  const grantId = str('grantId');
  const amount = str('amount');
  if (!tenantId || !userId || !grantId) throw new Error(`outbox event ${event.id} has a payload without its tenant, user or Grant`);
  if (event.type === OutboxEventType.GRANT_REFUNDED && !amount) throw new Error(`outbox event ${event.id} is a refund without its amount`);
  return { tenantId, userId, grantId, invoiceId: str('invoiceId'), amount, servicesUrl: str('servicesUrl') };
}
