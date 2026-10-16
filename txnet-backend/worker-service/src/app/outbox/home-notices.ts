import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BrokerService } from '../broker/broker.service';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';
import { EventNoticeSender, type EventNotice, type Person } from './event-notice';

/**
 * A person told in the tenant they live in (F-067-q): a bought reseller's
 * owner is a platform user, whom auth-service finds under no reseller's
 * tenant, so the event's own tenant is not where to look. One home for every
 * consumer that tells a person named by tenant and id (owner notices,
 * F-019-c; scheduled reports, F-1006-a).
 */
@Injectable()
export class HomeNotices {
  private readonly notices: EventNoticeSender;

  constructor(
    broker: BrokerService,
    redis: RedisService,
    realtime: RealtimePublisher,
    config: ConfigService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {
    this.notices = new EventNoticeSender(redis, realtime, config, broker);
  }

  /** `notice` with its person moved to their home tenant; one the users table does not know keeps the event's. */
  async send(notice: EventNotice & { person: Person }): Promise<void> {
    const home = await this.crossTenant.user.findUnique({ where: { id: notice.person.userId }, select: { tenantId: true } });
    await this.notices.send({ ...notice, person: { ...notice.person, tenantId: home?.tenantId ?? notice.person.tenantId } });
  }
}
