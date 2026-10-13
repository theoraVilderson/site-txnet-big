import { type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BrokerService } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';
import { EventNoticeSender } from './event-notice';

/** This consumer's segment of the processed-event key — not the live push's. */
const CONSUMER = 'access-notice';

/** Each cause identity writes (`AccessChangeCause`) and the template it is told with. */
const TEMPLATE_OF: Readonly<Record<string, string>> = {
  role_set: 'accessRoleSet',
  role_edited: 'accessKeysChanged',
  keys_set: 'accessKeysChanged',
  group_access: 'accessKeysChanged',
  group_membership_ended: 'accessMembershipEnded',
  key_window: 'accessKeyWindow',
  seat_removed: 'accessSeatRemoved',
  seat_restored: 'accessSeatRestored',
};

/**
 * Tell a person their access moved (AC-1-s): the inbox and the bot, through
 * `EventNoticeSender`'s `person` alone. The live half is `LivePushConsumer`'s
 * `{type}` on the same event (AC-1-q), which the panel already re-read on.
 *
 * The params are the payload's, untranslated: the role's name as written, and
 * the keys given and taken as keys — auth-service names each in the person's
 * language (AC-1-f's labels). A role edit, a key write (`keys_set`, AC-1-l), a
 * group change (`group_access`, AC-1-m) or an ended membership
 * (`group_membership_ended`, GR-1-c — with the group's name) or a key's
 * window opening or closing (`key_window`, F-030-a) that moved none
 * of their keys is told to no one. A cause with no template throws, so the producer that added
 * it sees a dead letter rather than a person who was never told.
 */
@Injectable()
export class AccessNoticeConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccessNoticeConsumer.name);
  private readonly notices: EventNoticeSender;

  constructor(
    private readonly broker: BrokerService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
    config: ConfigService,
  ) {
    this.notices = new EventNoticeSender(redis, realtime, config, broker);
  }

  async onApplicationBootstrap() {
    await this.broker.consumeAccessNotices((event) => this.handle(event));
    this.logger.log('consuming identity.access.changed for the person notice');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
    const keys = (k: string) => (Array.isArray(p[k]) ? (p[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    const tenantId = str('tenantId');
    const userId = str('userId');
    const cause = str('cause');
    if (!tenantId || !userId) throw new Error(`outbox event ${event.id} has a payload without its tenant or user`);
    const template = cause ? TEMPLATE_OF[cause] : undefined;
    if (!template) throw new Error(`outbox event ${event.id} has an access cause with no notice: ${cause}`);

    const params: Record<string, string> = {};
    if (cause === 'role_set') {
      const role = str('role');
      if (!role) throw new Error(`outbox event ${event.id} sets a role without naming it`);
      params.role = role;
    }
    if (cause === 'group_membership_ended') {
      const group = str('group');
      if (!group) throw new Error(`outbox event ${event.id} ends a membership without naming the group`);
      params.group = group;
    }
    if (cause === 'role_edited' || cause === 'keys_set' || cause === 'group_access' || cause === 'group_membership_ended' || cause === 'key_window') {
      const given = keys('given');
      const taken = keys('taken');
      if (given.length === 0 && taken.length === 0) return;
      if (given.length) params.given = given.join(',');
      if (taken.length) params.taken = taken.join(',');
    }

    await this.notices.send({ consumer: CONSUMER, eventId: event.id, person: { tenantId, userId, template, params } });
  }
}
