import { OutboxEventType, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BrokerService } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';
import { EventNoticeSender, type EventNotice } from './event-notice';

/** This consumer's segment of its per-channel markers (F-067-o). */
const CONSUMER = 'panel-tested';

/** The verdict each owner notice names; `pending` (a fault) is not one. */
const VERDICT_TEMPLATE: Record<string, string> = {
  accepted: 'panelAccepted',
  accepted_low_trust: 'panelAccepted',
  refused: 'panelRefused',
};

/** `network-service`'s `network.panel.tested` payload (`register.PostgresStore`). */
type PanelTested = {
  tenantId: string;
  panelId: string;
  panelName: string | null;
  ownerUserId: string | null;
  reviewState: unknown;
  fault: unknown;
};

/**
 * Push a connection test's verdict or fault to the owner's open systems page
 * (F-027-bs), and tell the owner a verdict in their inbox and bot (F-067-o).
 *
 * The channel is `tenant:<tenantId>` — the systems surface is an operator's,
 * not one user's — and the tenant is the one `network-service` named in the
 * payload: the panel's own, or the platform owner's for a platform panel.
 *
 * **Only a verdict reaches the inbox and the bot.** A fault is announced on
 * every retry, every 5 minutes while it lasts (network `contract.registration.md`);
 * the page re-reads on each, but a message each time would be noise. An event
 * written before the payload named its owner is pushed live and told to nobody.
 */
@Injectable()
export class PanelTestedConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PanelTestedConsumer.name);
  private readonly notices: EventNoticeSender;

  constructor(
    private readonly broker: BrokerService,
    redis: RedisService,
    realtime: RealtimePublisher,
    config: ConfigService,
  ) {
    this.notices = new EventNoticeSender(redis, realtime, config);
  }

  async onApplicationBootstrap() {
    await this.broker.consumePanelTested((event) => this.handle(event));
    this.logger.log('consuming network.panel.tested for the live systems page');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const tested = testedOf(event);
    const template = typeof tested.reviewState === 'string' ? VERDICT_TEMPLATE[tested.reviewState] : undefined;
    const person: EventNotice['person'] =
      template && tested.ownerUserId
        ? { tenantId: tested.tenantId, userId: tested.ownerUserId, template, params: { panel: tested.panelName ?? '' } }
        : undefined;
    await this.notices.send({
      consumer: CONSUMER,
      eventId: event.id,
      live: {
        channel: `tenant:${tested.tenantId}`,
        body: { type: OutboxEventType.PANEL_TESTED, panelId: tested.panelId, reviewState: tested.reviewState, fault: tested.fault },
      },
      person,
    });
  }
}

/** The payload, or a throw: an event that does not say whose panel it is is not one to guess about. */
function testedOf(event: OutboxMessage): PanelTested {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
  const tenantId = str('tenantId');
  const panelId = str('panelId');
  if (!tenantId || !panelId) {
    throw new Error(`outbox event ${event.id} has a payload without its tenant or panel`);
  }
  return {
    tenantId,
    panelId,
    panelName: str('panelName'),
    ownerUserId: str('ownerUserId'),
    reviewState: p.reviewState ?? null,
    fault: p.fault ?? null,
  };
}
