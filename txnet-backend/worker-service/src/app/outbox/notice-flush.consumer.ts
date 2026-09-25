import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BrokerService } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';
import { EventNoticeSender } from './event-notice';

/**
 * Tell a burst once its window has passed (F-067-p, ADR-0084 decision 3). The
 * flush was scheduled by the burst's first event through the delay queue; a
 * failed channel throws, so the flush dead-letters (F-067-d) with only that
 * channel owed.
 */
@Injectable()
export class NoticeFlushConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(NoticeFlushConsumer.name);
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
    await this.broker.consumeNoticeFlushes((flush) => this.notices.flush(flush));
    this.logger.log('consuming combined notice flushes');
  }
}
