import type { PanelDriftEventType, PanelFaultCause } from '@prisma/client';
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

/**
 * The notice each confirmed cause is told as (F-027-el, ADR-0122): grouped by
 * what the owner has to fix, so a changed port is never told as "re-enter
 * the login". Exhaustive over `network.PanelFaultCause` (C-07): a cause added
 * there and not here is refused, not told as nothing.
 */
export const PANEL_CAUSE_TEMPLATE: Record<PanelFaultCause, string> = {
  dns_failed: 'panelDownDns',
  connection_refused: 'panelDownPort',
  unreachable: 'panelDownUnreachable',
  unresponsive: 'panelDownUnreachable',
  tls_failed: 'panelDownTls',
  not_found: 'panelDownPath',
  server_error: 'panelDownServer',
  bad_answer: 'panelDownServer',
  login_refused: 'panelLoginRefused',
  forbidden: 'panelRefusingUs',
  rate_limited: 'panelRefusingUs',
};

/**
 * The notice a halting drift event is told as (F-027-fg, ADR-0130 decision 5),
 * by what the owner has to decide. Exhaustive over `network.PanelDriftEventType`
 * (C-07); the `mass_*` types other than a reset are schema only today and share
 * one notice.
 */
export const PANEL_DRIFT_TEMPLATE: Record<PanelDriftEventType, string> = {
  mass_reset: 'panelHaltedRestore',
  mass_missing: 'panelHaltedDrift',
  mass_rename: 'panelHaltedDrift',
  mass_limit_override: 'panelHaltedDrift',
  foreign_claim: 'panelHaltedForeign',
  identity_lost: 'panelHaltedIdentity',
  address_moved: 'panelHaltedAddress',
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
    this.notices = new EventNoticeSender(redis, realtime, config, broker);
  }

  async onApplicationBootstrap() {
    await this.broker.consumePanelTested((event) => this.handle(event));
    this.logger.log('consuming network.panel.tested, network.panel.state_changed and network.panel.drift_raised for the live systems page');
  }

  async handle(event: OutboxMessage): Promise<void> {
    if (event.type === OutboxEventType.PANEL_STATE_CHANGED) return this.stateChanged(event);
    if (event.type === OutboxEventType.PANEL_DRIFT_RAISED) return this.driftRaised(event);
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

  /**
   * A confirmed change of a panel's health (F-027-el, ADR-0122). Every one is
   * pushed, so an open systems page re-reads, and told to the owner: one is
   * written only on a real change of state or cause, and never for a turn
   * frozen as our own outage.
   */
  private async stateChanged(event: OutboxMessage): Promise<void> {
    const changed = stateChangedOf(event);
    const template = changed.panelState === 'healthy' ? 'panelRecovered' : changed.cause ? PANEL_CAUSE_TEMPLATE[changed.cause as PanelFaultCause] : undefined;
    if (!template) throw new Error(`outbox event ${event.id} names a cause no notice is written for: ${String(changed.cause)}`);
    await this.notices.send({
      consumer: CONSUMER,
      eventId: event.id,
      live: {
        channel: `tenant:${changed.tenantId}`,
        body: { type: OutboxEventType.PANEL_STATE_CHANGED, panelId: changed.panelId, panelState: changed.panelState, cause: changed.cause },
      },
      person: changed.ownerUserId
        ? { tenantId: changed.tenantId, userId: changed.ownerUserId, template, params: { panel: changed.panelName ?? '' } }
        : undefined,
    });
  }

  /**
   * A halting drift event (F-027-fg). `network-service` announces only the
   * halting ones, so every one stops a panel until a person decides: pushed, so
   * an open systems page re-reads, and told to the owner by what happened.
   */
  private async driftRaised(event: OutboxMessage): Promise<void> {
    const raised = driftRaisedOf(event);
    await this.notices.send({
      consumer: CONSUMER,
      eventId: event.id,
      live: {
        channel: `tenant:${raised.tenantId}`,
        body: { type: OutboxEventType.PANEL_DRIFT_RAISED, panelId: raised.panelId, driftEventId: raised.driftEventId, eventType: raised.eventType },
      },
      person: raised.ownerUserId
        ? { tenantId: raised.tenantId, userId: raised.ownerUserId, template: raised.template, params: { panel: raised.panelName ?? '' } }
        : undefined,
    });
  }
}

/** `network-service`'s `network.panel.drift_raised` payload (`collect.PostgresDriftEvents.Raise`), or a throw. */
function driftRaisedOf(event: OutboxMessage) {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
  const tenantId = str('tenantId');
  const panelId = str('panelId');
  const eventType = str('eventType');
  if (!tenantId || !panelId || !eventType) throw new Error(`outbox event ${event.id} has a payload without its tenant, panel or event type`);
  const template = PANEL_DRIFT_TEMPLATE[eventType as PanelDriftEventType] as string | undefined;
  if (!template) throw new Error(`outbox event ${event.id} names a drift event type no notice is written for: ${eventType}`);
  return { tenantId, panelId, eventType, template, driftEventId: str('driftEventId'), panelName: str('panelName'), ownerUserId: str('ownerUserId') };
}

/** `network-service`'s `network.panel.state_changed` payload (`panelstate.PostgresWriter`). */
type PanelStateChanged = { tenantId: string; panelId: string; panelName: string | null; ownerUserId: string | null; panelState: string; cause: string | null };


function stateChangedOf(event: OutboxMessage): PanelStateChanged {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
  const tenantId = str('tenantId');
  const panelId = str('panelId');
  const panelState = str('panelState');
  if (!tenantId || !panelId || !panelState) {
    throw new Error(`outbox event ${event.id} has a payload without its tenant, panel or state`);
  }
  return { tenantId, panelId, panelState, panelName: str('panelName'), ownerUserId: str('ownerUserId'), cause: str('cause') };
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
