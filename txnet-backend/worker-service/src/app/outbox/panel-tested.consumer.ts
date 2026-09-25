import { OutboxEventType, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { BrokerService } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';

/** `network-service`'s `network.panel.tested` payload (`register.PostgresStore`). */
type PanelTested = { tenantId: string; panelId: string; reviewState: unknown; fault: unknown };

/**
 * Push a connection test's verdict or fault to the owner's open systems page
 * (F-027-bs).
 *
 * The channel is `tenant:<tenantId>` — the systems surface is an operator's,
 * not one user's — and the tenant is the one `network-service` named in the
 * payload: the panel's own, or the platform owner's for a platform panel.
 *
 * **No marker.** The page only re-reads on this event, so a redelivery costs
 * one more read and nothing else; `TenantBillingCreditedConsumer` is the same
 * call for the same reason. `RealtimePublisher` never throws, and a closed
 * page reads the row on its next load, so at most once is enough.
 */
@Injectable()
export class PanelTestedConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PanelTestedConsumer.name);

  constructor(
    private readonly broker: BrokerService,
    private readonly realtime: RealtimePublisher,
  ) {}

  async onApplicationBootstrap() {
    await this.broker.consumePanelTested((event) => this.handle(event));
    this.logger.log('consuming network.panel.tested for the live systems page');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const tested = testedOf(event);
    await this.realtime.publish(`tenant:${tested.tenantId}`, {
      type: OutboxEventType.PANEL_TESTED,
      panelId: tested.panelId,
      reviewState: tested.reviewState,
      fault: tested.fault,
    });
  }
}

/** The payload, or a throw: an event that does not say whose panel it is is not one to guess about. */
function testedOf(event: OutboxMessage): PanelTested {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const tenantId = typeof p.tenantId === 'string' && p.tenantId !== '' ? p.tenantId : null;
  const panelId = typeof p.panelId === 'string' && p.panelId !== '' ? p.panelId : null;
  if (!tenantId || !panelId) {
    throw new Error(`outbox event ${event.id} has a payload without its tenant or panel`);
  }
  return { tenantId, panelId, reviewState: p.reviewState ?? null, fault: p.fault ?? null };
}
