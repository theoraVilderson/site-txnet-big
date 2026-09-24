import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvConfig } from '../config/env.validation';
import { DeltaConsumer } from './delta.consumer';
import { MeteringService } from './metering.service';
import { SubUsagePublisher } from './sub-usage.publisher';
import { SubUsageRedis } from './sub-usage.redis';

@Module({
  providers: [
    MeteringService,
    DeltaConsumer,
    SubUsageRedis,
    {
      provide: SubUsagePublisher,
      useFactory: (redis: SubUsageRedis, config: ConfigService<EnvConfig, true>) =>
        new SubUsagePublisher(redis.client, config.get('SUB_USAGE_TTL_SECONDS', { infer: true })),
      inject: [SubUsageRedis, ConfigService],
    },
  ],
})
export class MeteringModule {}
